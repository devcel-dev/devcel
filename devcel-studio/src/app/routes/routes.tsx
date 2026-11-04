import { useI18n, t } from '@/app/i18n';
import { createBrowserRouter } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { MainWindow } from '../pages/main_window/MainWindow';

// Lazy load dialog components for better startup performance
const ProjectCreateWizard = lazy(() => import('../pages/project_create_wizard/ProjectCreateWizard').then(m => ({ default: m.ProjectCreateWizard })));
const ProjectEditDialog = lazy(() => import('../pages/project_edit_dialog/ProjectEditDialog').then(m => ({ default: m.ProjectEditDialog })));
const PluginManagerPage = lazy(() => import('../pages/plugin_manager/PluginManagerPage').then(m => ({ default: m.PluginManagerPage })));
const PluginPackagePage = lazy(() => import('../pages/plugin_packages/PluginPackagePage').then(m => ({ default: m.PluginPackagePage })));
const ExportDialog = lazy(() => import('../pages/export_dialog/ExportDialog'));

const AppUpdaterPage = lazy(() => import('../pages/app_updater/AppUpdaterPage').then(m => ({ default: m.AppUpdaterPage })));

const BulkRowDialog = lazy(() => import('../pages/bulk_row_dialog/BulkRowDialog'));


const TableRuleDialog = lazy(() => import('../pages/table_rule_dialog/TableRuleDialog'));




// Loading fallback component
const LoadingFallback = () => { useI18n(); return ((
  <div className="flex items-center justify-center h-screen">
    <div className="text-muted-foreground">{t('common.loading')}</div>
  </div>
)); };


export const router = createBrowserRouter([
  { path: '/bulk_row_dialog', element: <Suspense fallback={<LoadingFallback />}><BulkRowDialog /></Suspense> },
  { path: '/table_rule_dialog', element: <Suspense fallback={<LoadingFallback />}><TableRuleDialog /></Suspense> },
  {
    path: '/',
    element: <MainWindow />
  },
  {
    path: '/project_create_wizard',
    element: (
      <Suspense fallback={<LoadingFallback />}>
        <ProjectCreateWizard />
      </Suspense>
    )
  },
  {
    path: '/project_edit_dialog',
    element: (
      <Suspense fallback={<LoadingFallback />}>
        <ProjectEditDialog />
      </Suspense>
    )
  },
  {
    path: '/app_updater',
    element: <Suspense fallback={<LoadingFallback />}><AppUpdaterPage /></Suspense>
  },
  {
    path: '/plugin_packages',
    element: <Suspense fallback={<LoadingFallback />}><PluginPackagePage /></Suspense>
  },
  {
    path: '/plugin_manager',
    element: (
      <Suspense fallback={<LoadingFallback />}>
        <PluginManagerPage />
      </Suspense>
    )
  },
  {
    path: '/export_dialog',
    element: (
      <Suspense fallback={<LoadingFallback />}>
        <ExportDialog />
      </Suspense>
    )
  },
]);
