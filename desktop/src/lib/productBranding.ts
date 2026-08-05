export const PRODUCT_REPOSITORY = 'https://github.com/yefansky/cc-haha'
export const PRODUCT_RELEASES_URL = `${PRODUCT_REPOSITORY}/releases`
export const PRODUCT_ISSUES_URL = `${PRODUCT_REPOSITORY}/issues`
export const PRODUCT_UPDATE_FEED = {
  provider: 'github',
  owner: 'yefansky',
  repo: 'cc-haha',
} as const

export const PRODUCT_AUTHORS = [
  {
    name: '程序员阿江-Relakkes',
    url: 'https://github.com/NanmiCoder',
    role: 'original',
  },
  {
    name: '叶帆',
    url: 'https://github.com/yefansky',
    role: 'customization',
  },
] as const
