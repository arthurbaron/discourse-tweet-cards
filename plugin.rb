# name: discourse-tweet-cards
# about: Renders X/Twitter links as native tweet cards via the fxtwitter API
# version: 0.4.2
# authors: Online Arsenal Community
# url: https://github.com/arthurbaron/discourse-tweet-cards

register_asset "stylesheets/common/discourse-tweet-cards.scss"

# Note: Discourse currently treats connect_src, img_src and media_src as no-ops
# (see ContentSecurityPolicy::Builder::TO_BE_EXTENDABLE) and ships no default-src,
# so none of these are enforced today. Declared anyway so the plugin keeps
# working if core starts including them in the default policy.
extend_content_security_policy(
  connect_src: %w[https://api.fxtwitter.com],
  img_src: %w[https://pbs.twimg.com],
  media_src: %w[https://video.fxtwitter.com]
)
