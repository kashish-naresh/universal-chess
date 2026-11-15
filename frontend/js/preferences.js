(function (root, factory) {
  const preferences = factory();
  if (typeof module === 'object' && module.exports) module.exports = preferences;
  if (root) root.UniversalChessPreferences = preferences;
  if (root?.document) {
    try { root.document.documentElement.dataset.theme = preferences.loadTheme(root.localStorage); }
    catch { root.document.documentElement.dataset.theme = 'dark'; }
  }
})(typeof window === 'undefined' ? globalThis : window, function () {
  const THEME_KEY = 'universal-chess-theme';
  return {
    loadTheme(storage) { return storage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; },
    saveTheme(storage, theme) {
      const selected = theme === 'light' ? 'light' : 'dark';
      storage.setItem(THEME_KEY, selected);
      return selected;
    }
  };
});
