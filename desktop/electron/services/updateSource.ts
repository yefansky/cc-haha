import { PRODUCT_UPDATE_FEED } from '../../src/lib/productBranding'

type FeedConfigurableUpdater = {
  setFeedURL(options: typeof PRODUCT_UPDATE_FEED): void
}

export function configureProductUpdateFeed(updater: FeedConfigurableUpdater) {
  updater.setFeedURL(PRODUCT_UPDATE_FEED)
}
