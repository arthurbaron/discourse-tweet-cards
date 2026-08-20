import { withPluginApi } from "discourse/lib/plugin-api";

const cache = new Map();

function extractTweetId(url) {
  return url.match(/\/status\/(\d+)/)?.[1] ?? null;
}

async function fetchTweet(id) {
  if (cache.has(id)) {
    return cache.get(id);
  }
  try {
    const res = await fetch(`https://api.fxtwitter.com/status/${id}`);
    if (!res.ok) {
      return null;
    }
    const { code, tweet } = await res.json();
    if (code !== 200 || !tweet) {
      return null;
    }
    cache.set(id, tweet);
    return tweet;
  } catch {
    return null;
  }
}

function formatCount(n) {
  if (!n) {
    return null;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(n);
}

function safeText(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// safeText escapes &, < and > but not quotes, which is not enough for a value
// that lands inside an HTML attribute.
function safeAttr(str) {
  return safeText(str).replace(/"/g, "&quot;");
}

// video.twimg.com refuses any request carrying a Referer other than x.com, so
// linking a <video> straight at it returns 403 from inside a forum page.
// video.fxtwitter.com mirrors the exact same paths, fetches server-side (no
// browser Referer involved) and supports range requests, so playback and
// seeking work normally.
function proxiedMediaUrl(url) {
  return url.replace(
    "https://video.twimg.com/",
    "https://video.fxtwitter.com/"
  );
}

// Cap on how much data playback may pull. X serves adaptive HLS; we pick a
// single mp4 instead, so this is where quality trades off against mobile data.
const MAX_VIDEO_BITRATE = 2_000_000;

// Tallest a clip may render. Portrait ones would otherwise take over the post.
const MAX_VIDEO_HEIGHT = 500;
const MAX_GIF_HEIGHT = 400;

// Height alone cannot cap a portrait clip: the element would stay full width and
// letterbox itself. Deriving a max width from the height cap keeps the box tight
// around the footage instead. Both are emitted inline so the frame is reserved
// before any bytes arrive and the post never jumps.
function videoBox(video, maxHeight) {
  const hasSize = video.width > 0 && video.height > 0;
  const aspect = hasSize ? video.width / video.height : 16 / 9;
  return {
    ratio: hasSize ? `${video.width} / ${video.height}` : "16 / 9",
    cappedWidth: Math.round(maxHeight * aspect),
  };
}

function pickVideoSource(video) {
  const mp4s = (video.formats || [])
    .filter((f) => f.container === "mp4" && f.url)
    .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));

  if (!mp4s.length) {
    return video.url || null;
  }

  const withinBudget = mp4s.filter(
    (f) => (f.bitrate || 0) <= MAX_VIDEO_BITRATE
  );
  return (withinBudget[withinBudget.length - 1] || mp4s[0]).url;
}

// Twitter HTML-escapes &, < and > in its classic text field, and raw_text keeps
// that escaping while its offsets are counted over the escaped form. So decoding
// has to happen after slicing, never before, or every index shifts.
//
// Order matters: &amp; is decoded last. Doing it first would turn a literal
// "&lt;" that arrived as "&amp;lt;" into a real "<". Escaping happens afterwards
// in plainText, so this never widens what the browser will execute.
function decodeEntities(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function plainText(str) {
  return safeText(str).replace(/\n/g, "<br>");
}

function externalLink(href, label) {
  return (
    `<a href="${safeAttr(href)}" target="_blank" rel="noopener nofollow">` +
    `${safeText(label)}</a>`
  );
}

// `literal` is the exact slice the facet covers, so it still carries the @ or #
// that the entity data leaves out.
function renderFacet(facet, literal) {
  switch (facet.type) {
    case "url":
      // display is the readable form X shows, e.g. arsenal.com/news rather than
      // the t.co shortlink, and replacement is where it actually goes.
      return externalLink(
        facet.replacement || facet.original || literal,
        facet.display || literal
      );
    case "mention":
      return externalLink(`https://x.com/${facet.original}`, literal);
    case "hashtag":
      return externalLink(
        `https://x.com/hashtag/${encodeURIComponent(facet.original ?? literal.slice(1))}`,
        literal
      );
    case "symbol":
      return externalLink(
        `https://x.com/search?q=${encodeURIComponent(literal)}`,
        literal
      );
    case "bold":
      return `<strong>${plainText(literal)}</strong>`;
    case "italic":
      return `<em>${plainText(literal)}</em>`;
    case "underline":
      return `<u>${plainText(literal)}</u>`;
    case "strikethrough":
      return `<s>${plainText(literal)}</s>`;
    // The media itself is rendered separately; X does not show its URL either.
    case "media":
    case "inline_media":
      return "";
    default:
      return plainText(literal);
  }
}

// A facet that says what it covers lets us check the offsets actually line up.
// Note tweets carry media facets whose indices were computed against the
// truncated 280 character version of the post, not the full text, so they point
// into the middle of a sentence. Because a media facet renders as nothing, that
// silently deleted exactly 23 characters of prose, the length of a t.co link.
// Facets without an `original` carry no claim to check, so they are trusted.
function facetOffsetsAgree(facet, literal) {
  if (!facet.original) {
    return true;
  }

  const sameWord = (prefix) =>
    literal.toLowerCase() === `${prefix}${facet.original}`.toLowerCase();

  switch (facet.type) {
    case "url":
    case "media":
      return literal === facet.original;
    // Case can differ from the canonical form, e.g. @arsenal for @Arsenal.
    case "mention":
      return sameWord("@");
    case "hashtag":
      return sameWord("#");
    case "symbol":
      return sameWord("$");
    default:
      return true;
  }
}

// Replaces regex matching on the rendered HTML, which broke on any hashtag or
// handle outside plain ASCII. The API hands us exact entity offsets instead.
//
// Three traps in that data. First, Twitter counts offsets in Unicode code points
// while JS strings are indexed in UTF-16, so one emoji earlier in the text shifts
// every later index by one and naive slicing tears the emoji in half. Splitting
// to a code point array fixes that. Second, several facets can cover the same
// range, for instance two photos sharing one t.co link. Third, some offsets do
// not match their own facet at all, which facetOffsetsAgree filters out.
function renderTweetText(tweet) {
  const raw = tweet.raw_text;
  if (!raw?.text) {
    return plainText(tweet.text || "");
  }

  const chars = Array.from(raw.text);
  const [rangeStart, rangeEnd] = raw.display_text_range ?? [0, chars.length];
  // Note tweets report a range that ends past their own text, so clamp both ends
  // before anything gets compared against them.
  const start = Math.max(0, Math.min(rangeStart, chars.length));
  const end = Math.max(start, Math.min(rangeEnd, chars.length));
  const cardUrl = tweet.card?.url;

  const facets = (raw.facets || [])
    .filter(
      (f) =>
        f.indices?.length === 2 && f.indices[0] >= start && f.indices[1] <= end
    )
    .sort((a, b) => a.indices[0] - b.indices[0] || b.indices[1] - a.indices[1]);

  let out = "";
  let cursor = start;

  for (const facet of facets) {
    const [from, to] = facet.indices;
    if (from < cursor) {
      continue;
    }

    const literal = decodeEntities(chars.slice(from, to).join(""));
    if (!facetOffsetsAgree(facet, literal)) {
      continue;
    }

    // A link card stands in for the URL it was built from, so drop that URL from
    // the text the way X does.
    if (cardUrl && facet.type === "url" && to === end) {
      out += plainText(
        decodeEntities(chars.slice(cursor, from).join(""))
      ).replace(/(\s|<br>)+$/, "");
      return out;
    }

    out += plainText(decodeEntities(chars.slice(cursor, from).join("")));
    out += renderFacet(facet, literal);
    cursor = to;
  }

  return out + plainText(decodeEntities(chars.slice(cursor, end).join("")));
}

function renderLinkCard(card) {
  if (!card?.url) {
    return "";
  }
  const image = card.image?.url
    ? `<img class="tweet-card-link-image" src="${safeText(card.image.url)}" alt="" loading="lazy">`
    : "";
  const description = card.description
    ? `<p class="tweet-card-link-description">${safeText(card.description)}</p>`
    : "";
  return `
    <a href="${safeText(card.url)}" target="_blank" rel="noopener nofollow" class="tweet-card-link">
      ${image}
      <div class="tweet-card-link-body">
        <span class="tweet-card-link-domain">${safeText(card.domain || new URL(card.url).hostname)}</span>
        <p class="tweet-card-link-title">${safeText(card.title || "")}</p>
        ${description}
      </div>
    </a>
  `.trim();
}

function renderMedia(media, tweetUrl) {
  if (!media?.photos?.length && !media?.videos?.length) {
    return "";
  }

  const items = [];

  for (const photo of media.photos || []) {
    items.push(
      `<img src="${safeText(photo.url)}" alt="${safeText(photo.altText || "")}" loading="lazy">`
    );
  }

  for (const video of media.videos || []) {
    if (video.type === "gif") {
      // X stores "GIFs" as silent mp4 and only presents them as GIFs. We used to
      // route them through gif.fxtwitter.com, which transcodes to a real .gif,
      // roughly 18x the bytes for the same few seconds. Serving the source mp4
      // looped is both smaller and smoother.
      const source = pickVideoSource(video);

      if (source) {
        const { ratio, cappedWidth } = videoBox(video, MAX_GIF_HEIGHT);
        const poster = video.thumbnail_url
          ? ` poster="${safeAttr(video.thumbnail_url)}"`
          : "";
        // preload="none" plus no autoplay attribute: nothing is fetched until
        // activateGifs sees the element enter the viewport.
        items.push(
          `<div class="tweet-card-gif-wrap" style="max-width: min(100%, ${cappedWidth}px)">` +
            `<video class="tweet-card-gif" muted loop playsinline preload="none"` +
            ` aria-label="GIF" style="aspect-ratio: ${ratio}"${poster}` +
            ` src="${safeAttr(proxiedMediaUrl(source))}"></video>` +
            `<span class="tweet-card-gif-badge" aria-hidden="true">GIF</span>` +
            `</div>`
        );
      }
    } else {
      const source = pickVideoSource(video);

      if (source) {
        // preload="metadata" is only a hint: browsers buffer a few seconds
        // ahead anyway, so expect a few hundred KB before anyone presses play.
        // Still far short of the whole file, which is the point.
        const { ratio, cappedWidth } = videoBox(video, MAX_VIDEO_HEIGHT);
        const poster = video.thumbnail_url
          ? ` poster="${safeAttr(video.thumbnail_url)}"`
          : "";

        items.push(
          `<video class="tweet-card-video" controls playsinline preload="metadata"` +
            ` style="aspect-ratio: ${ratio}; max-width: min(100%, ${cappedWidth}px)"${poster}` +
            ` src="${safeAttr(proxiedMediaUrl(source))}"></video>`
        );
      } else if (video.thumbnail_url) {
        // No playable source in the response: fall back to opening on X.
        items.push(
          `<a href="${safeText(tweetUrl)}" target="_blank" rel="noopener nofollow" class="tweet-card-video-thumb">` +
            `<img src="${safeText(video.thumbnail_url)}" alt="Video" loading="lazy">` +
            `<div class="tweet-card-play-icon" aria-hidden="true">▶</div>` +
            `</a>`
        );
      }
    }
  }

  if (!items.length) {
    return "";
  }

  return `<div class="tweet-card-media tweet-card-media--${items.length}">${items.join("")}</div>`;
}

function renderCard(tweet) {
  const {
    author,
    likes,
    retweets,
    replies,
    views,
    created_timestamp,
    url,
    media,
    card,
  } = tweet;

  const locale = document.documentElement.lang || "en";
  const date = new Date(created_timestamp * 1000).toLocaleString(
    locale,
    { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
  );

  const stats = [
    likes ? `<span title="Likes">${formatCount(likes)} likes</span>` : null,
    views ? `<span title="Views">${formatCount(views)} views</span>` : null,
  ]
    .filter(Boolean)
    .join("");


  return `
    <div class="tweet-card">
      <div class="tweet-card-header">
        <a href="https://x.com/${safeText(author.screen_name)}" target="_blank" rel="noopener nofollow" class="tweet-card-author">
          <img class="tweet-card-avatar" src="${safeText(author.avatar_url)}" alt="" loading="lazy">
          <div class="tweet-card-author-info">
            <span class="tweet-card-name">${safeText(author.name)}</span>
            <span class="tweet-card-handle">@${safeText(author.screen_name)}</span>
          </div>
        </a>
        <a href="${safeText(url)}" target="_blank" rel="noopener nofollow" class="tweet-card-x-logo" aria-label="View on X">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
          </svg>
        </a>
      </div>
      <div class="tweet-card-text">${renderTweetText(tweet)}</div>
      ${renderMedia(media, url)}
      ${renderLinkCard(card)}
      <div class="tweet-card-footer">
        <div class="tweet-card-stats">${stats}</div>
        <time class="tweet-card-date">${date}</time>
      </div>
    </div>
  `.trim();
}

// GIFs only start loading once they are actually on screen, and pause again when
// they leave. A topic full of them would otherwise pull every clip at once, which
// is most of the point of moving off the .gif route. Returns a disposer.
function activateGifs(cardEl) {
  const gifs = cardEl.querySelectorAll("video.tweet-card-gif");
  if (!gifs.length) {
    return null;
  }

  // Someone who asked the OS for less motion should not get looping video.
  // Give them the poster frame plus controls to opt in instead.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    for (const gif of gifs) {
      gif.setAttribute("controls", "");
      gif.removeAttribute("loop");
      gif.preload = "metadata";
    }
    return null;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        if (isIntersecting) {
          // play() rejects if the element is torn down mid-call; nothing to do.
          target.play().catch(() => {});
        } else {
          target.pause();
        }
      }
    },
    { rootMargin: "100px" }
  );

  for (const gif of gifs) {
    observer.observe(gif);
  }

  return () => observer.disconnect();
}

// Discourse attaches a delegated jQuery handler on ".cooked a" that intercepts
// ALL link clicks, calls preventDefault, and handles navigation itself.
// This means target="_blank" is ignored. We stop propagation on every link
// inside the tweet card so the browser handles them natively instead.
function preventDiscourseClickInterception(cardEl) {
  for (const a of cardEl.querySelectorAll("a")) {
    a.addEventListener("click", (e) => e.stopImmediatePropagation());
  }
}

function collectTweetTargets(el) {
  const targets = [];

  for (const domain of ["twitter.com", "x.com"]) {
    for (const a of el.querySelectorAll(
      `a.onebox[href^="https://${domain}/"][href*="/status/"]`
    )) {
      const id = extractTweetId(a.href);
      if (id) {
        targets.push({ id, el: a });
      }
    }
  }

  for (const aside of el.querySelectorAll("aside.onebox[data-onebox-src]")) {
    const src = aside.getAttribute("data-onebox-src");
    if (!/(?:twitter|x)\.com\/.+\/status\//i.test(src)) {
      continue;
    }
    const id = extractTweetId(src);
    if (id) {
      targets.push({ id, el: aside });
    }
  }

  return targets;
}

export default {
  name: "discourse-tweet-cards",
  initialize() {
    withPluginApi("1.0.0", (api) => {
      // This callback is deliberately synchronous. Discourse only treats a
      // returned *function* as a cleanup hook, and an async callback would
      // hand it a Promise instead, so the fetching runs fire-and-forget.
      api.decorateCookedElement(
        (el) => {
          const targets = collectTweetTargets(el);
          if (!targets.length) {
            return;
          }

          const rendered = [];
          const disposers = [];
          let discarded = false;

          for (const { id, el: target } of targets) {
            fetchTweet(id).then((tweet) => {
              if (discarded || !tweet) {
                return;
              }
              const wrapper = document.createElement("div");
              wrapper.innerHTML = renderCard(tweet);
              const cardEl = wrapper.firstElementChild;
              preventDiscourseClickInterception(cardEl);
              target.replaceWith(cardEl);
              rendered.push(cardEl);

              // After insertion, so the observer sees real geometry right away.
              const dispose = activateGifs(cardEl);
              if (dispose) {
                disposers.push(dispose);
              }
            });
          }

          // Runs when the post is rerendered or leaves the stream. Without it a
          // video keeps buffering and holding memory after its post is gone.
          return () => {
            discarded = true;
            for (const dispose of disposers) {
              dispose();
            }
            for (const cardEl of rendered) {
              for (const video of cardEl.querySelectorAll("video")) {
                video.pause();
                video.removeAttribute("src");
                video.load();
              }
            }
          };
        },
        {
          id: "discourse-tweet-cards",
          // Ignored on current Discourse, which dropped the option entirely.
          // Kept for older versions. Timing no longer depends on it either
          // way: the card is swapped in asynchronously, after adoption.
          afterAdopt: true,
          onlyStream: true,
        }
      );
    });
  },
};
