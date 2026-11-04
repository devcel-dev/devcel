// Locally authored SDK fixture. Installation never executes this file.
module.exports = {
  metadata: {
  "id": "report-tools",
  "name": "Report tools fixture",
  "version": "1.0.0",
  "description": "SDK example for independently owned settings and translation tables. Not bundled.",
  "author": "Devcel SDK",
  "devcelVersion": ">=0.0.2 <1.0.0",
  "apiVersion": "2.0.0"
},
  activate: async api => {
    api.ui.registerCommand('report-tools.preview', () => {
      const { prefix } = api.settings.getTable('preferences');
      api.ui.showNotification(`${api.i18n.t('title')}: ${prefix}`, 'info');
    });
  },
  deactivate: async () => {}
};
