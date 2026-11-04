// esbuild importer/onLoad paths are native filesystem paths, not import specifiers.
// Keep these actual boundary filters shared with the cross-platform regression.
const wizardSettingsImporter = /[\\/]settings[\\/](AppTheme\.tsx|dialogTheme\.ts)$/;
const gridSelectionSource = /[\\/]react-data-grid[\\/]DataGrid\.tsx$/;
const formulaRepairSource = /[\\/]editors[\\/](textEditor|validatedTextEditor)\.tsx$/;
module.exports = { wizardSettingsImporter, gridSelectionSource, formulaRepairSource };
