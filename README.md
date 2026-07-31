# discourse-tweet-cards

Renders X (Twitter) links in posts as native-looking cards, with inline video
playback, looping GIFs, photos and link previews.

No API key and no paid X API access required.

## Why this exists

Discourse removed its built-in Twitter onebox because X made the required API
access paid. Pasted X links therefore render as a bare URL or an empty onebox.

This plugin fills that gap by reading public post data from the
[FxEmbed](https://github.com/FxEmbed/FxEmbed) API (`api.fxtwitter.com`) in the
browser and replacing the onebox with a rendered card.

## What it renders

- Author avatar, display name and handle, each linking to the profile
- Post text with mentions, hashtags, cashtags and links resolved from the API's
  entity data, including bold, italic, underline and strikethrough in long posts
- Links shown in their readable form (`arsenal.com/news`) rather than as the
  `t.co` shortlink
- Photos, in a grid for multi-photo posts
- **Video, playing inline** with normal controls and seeking
- **GIFs as looping silent video**, started only once scrolled into view
- Link preview cards
- Footer with like count, view count and the post date in the forum's language

## Requirements

- Discourse with plugin support (developed against `2026.8.0-latest`)
- Outbound access from the visitor's browser to `api.fxtwitter.com`,
  `video.fxtwitter.com` and `pbs.twimg.com`

There are no site settings and no admin toggle. Enabling or disabling the plugin
means changing the container configuration and rebuilding.

## Installation

Add the clone line to the `hooks` block of your container configuration.
That is `containers/app.yml` on a standard install, or `containers/web_only.yml`
if you run a separate data container:

```yaml
hooks:
  after_code:
    - exec:
        cd: $home/plugins
        cmd:
          - git clone https://github.com/arthurbaron/discourse-tweet-cards.git
```

Then rebuild:

```bash
cd /var/discourse
sudo ./launcher rebuild app
```

Use `rebuild web_only` instead if that is the container holding your web app.

To deploy a specific branch, pin it on the clone line:

```
- git clone -b some-branch --single-branch https://github.com/arthurbaron/discourse-tweet-cards.git
```

Remember to remove the pin afterwards, otherwise the plugin stays on that branch
and misses later changes.

## How it works

A `decorateCookedElement` decorator scans rendered posts for X links, in both
forms Discourse produces: an `a.onebox` link when core could not onebox it, and
an `aside.onebox` element when it could. Each post ID is fetched once and cached
in memory until the page is reloaded, then the element is replaced with the card.

The decorator returns a cleanup function, so video is paused and released when a
post is rerendered or scrolled out of the post stream.

### Why media goes through a proxy

`video.twimg.com` serves its mp4 files with `access-control-allow-origin: *` and
supports range requests, but rejects any request whose `Referer` is not `x.com`.
From a forum page that is a `403`, which is why video used to fall back to a
thumbnail linking out to X.

`video.fxtwitter.com` mirrors the same paths and fetches server-side, so no
browser `Referer` is involved. Swapping the host is enough for real playback with
seeking, and responses are CDN-cached, so your forum serves no media itself.

The same host replaces the old `.gif` transcoding route. X stores "GIFs" as
silent mp4 and only presents them as GIFs, so serving the source mp4 looped is
both far smaller and smoother. On one measured clip that is 0.97 MB against
17.6 MB for the transcoded `.gif`.

Images from `pbs.twimg.com` have no such `Referer` restriction and are loaded
directly.

## Tuning

Three constants at the top of
`assets/javascripts/discourse/initializers/discourse-tweet-cards.js`:

| Constant | Default | Effect |
| --- | --- | --- |
| `MAX_VIDEO_BITRATE` | `2_000_000` | Which mp4 variant is chosen. Higher looks better and costs more mobile data. |
| `MAX_VIDEO_HEIGHT` | `500` | Tallest a video may render, which also caps its width so portrait clips stay narrow. |
| `MAX_GIF_HEIGHT` | `400` | Same, for GIFs. |

Card width, colours and spacing live in
`assets/stylesheets/common/discourse-tweet-cards.scss` and follow Discourse's own
theme variables, so light and dark both work.

## Accessibility

GIFs do not autoplay when the visitor's system asks for reduced motion. They get
the poster frame with controls instead, so playback stays opt-in.

## Limitations

- Depends on a third-party service. If `api.fxtwitter.com` is unreachable the
  onebox is left untouched rather than replaced.
- Quoted posts, polls and Community Notes are present in the API response but are
  not rendered yet.
- Video uses a single mp4 variant rather than adaptive streaming, so quality does
  not adjust to the connection.
- No site settings, so no admin-facing switch and no per-category control.
- Protected and deleted posts cannot be rendered, since the API only exposes
  public data.
- The plugin declares `connect_src`, `img_src` and `media_src` in its content
  security policy, but Discourse currently treats those directives as no-ops and
  ships no `default-src`, so they are not enforced today. They are declared so the
  plugin keeps working if core starts including them.
