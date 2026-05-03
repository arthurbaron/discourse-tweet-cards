# name: discourse-tweet-cards
# about: Renders X/Twitter links as native tweet cards via the fxtwitter API
# version: 0.1.0
# authors: Online Arsenal Community
# url: https://github.com/arthurbaron/discourse-tweet-cards

register_asset "stylesheets/common/discourse-tweet-cards.scss"

extend_content_security_policy(
  connect_src: %w[https://api.fxtwitter.com],
  img_src: %w[https://gif.fxtwitter.com https://pbs.twimg.com]
)
