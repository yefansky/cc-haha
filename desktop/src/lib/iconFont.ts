/** Font-display's block period expires on slow links; never expose ligature text. */
export function initializeIconFont(doc: Document = document): void {
  if (!doc.fonts) return
  doc.documentElement.dataset.iconFont = 'loading'
  const loaded = () => {
    if (doc.fonts.check('24px "Material Symbols Outlined"')) {
      doc.documentElement.dataset.iconFont = 'ready'
      doc.fonts.removeEventListener('loadingdone', loaded)
    }
  }
  doc.fonts.addEventListener('loadingdone', loaded)
  void doc.fonts.load('24px "Material Symbols Outlined"').then(loaded).catch(() => {
    // Keep icon slots stable if offline; a later successful font load recovers.
  })
}
