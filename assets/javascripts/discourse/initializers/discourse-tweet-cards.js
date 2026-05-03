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

function renderTweetText(text) {
  return safeText(text)
    .replace(/\n/g, "<br>")
    .replace(
      /(https?:\/\/t\.co\/\S+)/g,
      '<a href="$1" target="_blank" rel="noopener nofollow">$1</a>'
    )
    .replace(
      /@(\w+)/g,
      '<a href="https://x.com/$1" target="_blank" rel="noopener nofollow">@$1</a>'
    )
    .replace(
      /#(\w+)/g,
      '<a href="https://x.com/hashtag/$1" target="_blank" rel="noopener nofollow">#$1</a>'
    );
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
    if (video.type === "gif" && video.url) {
      // d.fxtwitter.com redirects tweet_video/*.mp4 to gif.fxtwitter.com/*.gif —
      // their own CDN, no Twitter auth required. Construct the URL directly.
      const gifUrl = video.url
        .replace("https://video.twimg.com/", "https://gif.fxtwitter.com/")
        .replace(/\.mp4$/, ".gif");
      items.push(
        `<img class="tweet-card-gif" src="${safeText(gifUrl)}" alt="GIF" loading="lazy">`
      );
    } else if (video.thumbnail_url) {
      // Regular video: Twitter CDN blocks cross-origin requests, link to tweet instead.
      items.push(
        `<a href="${safeText(tweetUrl)}" target="_blank" rel="noopener nofollow" class="tweet-card-video-thumb">` +
          `<img src="${safeText(video.thumbnail_url)}" alt="Video" loading="lazy">` +
          `<div class="tweet-card-play-icon" aria-hidden="true">▶</div>` +
          `</a>`
      );
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
    text,
    likes,
    retweets,
    replies,
    views,
    created_timestamp,
    url,
    media,
  } = tweet;

  const locale = document.documentElement.lang || "en";
  const date = new Date(created_timestamp * 1000).toLocaleString(
    locale,
    { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
  );

  const stats = [
    replies ? `<span title="Replies">${formatCount(replies)} replies</span>` : null,
    retweets ? `<span title="Retweets">${formatCount(retweets)} retweets</span>` : null,
    likes ? `<span title="Likes">${formatCount(likes)} likes</span>` : null,
    views ? `<span title="Views">${formatCount(views)} views</span>` : null,
  ]
    .filter(Boolean)
    .join("");

  const verifiedBadge = author.verified
    ? `<svg class="tweet-card-verified" viewBox="0 0 24 24" aria-label="Verified" role="img">` +
      `<path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"/>` +
      `</svg>`
    : "";

  return `
    <div class="tweet-card">
      <div class="tweet-card-header">
        <a href="https://x.com/${safeText(author.screen_name)}" target="_blank" rel="noopener nofollow" class="tweet-card-author">
          <img class="tweet-card-avatar" src="${safeText(author.avatar_url)}" alt="" loading="lazy">
          <div class="tweet-card-author-info">
            <span class="tweet-card-name">${safeText(author.name)}${verifiedBadge}</span>
            <span class="tweet-card-handle">@${safeText(author.screen_name)}</span>
          </div>
        </a>
        <a href="${safeText(url)}" target="_blank" rel="noopener nofollow" class="tweet-card-x-logo" aria-label="View on X">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
          </svg>
        </a>
      </div>
      <div class="tweet-card-text">${renderTweetText(text)}</div>
      ${renderMedia(media, url)}
      <div class="tweet-card-footer">
        <div class="tweet-card-stats">${stats}</div>
        <time class="tweet-card-date">${date}</time>
      </div>
    </div>
  `.trim();
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
      api.decorateCookedElement(
        async (el) => {
          const targets = collectTweetTargets(el);
          if (!targets.length) {
            return;
          }

          await Promise.all(
            targets.map(async ({ id, el: target }) => {
              const tweet = await fetchTweet(id);
              if (!tweet) {
                return;
              }
              const wrapper = document.createElement("div");
              wrapper.innerHTML = renderCard(tweet);
              const cardEl = wrapper.firstElementChild;
              preventDiscourseClickInterception(cardEl);
              target.replaceWith(cardEl);
            })
          );
        },
        {
          id: "discourse-tweet-cards",
          afterAdopt: true,
          onlyStream: true,
        }
      );
    });
  },
};
