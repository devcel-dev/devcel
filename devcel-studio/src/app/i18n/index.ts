import { useSyncExternalStore } from 'react';
import { IntlMessageFormat } from 'intl-messageformat';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import catalog from './generated/catalog.json';
import appCatalog from '@/app/settings/generated/catalog.json';
import type { MessageArgs, MessageKey } from './generated/keys';

export type { MessageArgs, MessageKey } from './generated/keys';
export type Locale = string;
export type LocalePreference = Locale | null;
type Values = Record<string, string | number | Date>;
type Arguments<K extends MessageKey> = keyof MessageArgs[K] extends never
  ? [values?: never] : [values: MessageArgs[K]];
import type { Diagnostic, AppError } from '@/app/types/tableRules';
export type { Diagnostic, AppError } from '@/app/types/tableRules';
type DescriptorValues = Record<string, string | number | Date | AppError | LocalizedMessage>;
type DescriptorArguments<K extends MessageKey> = keyof MessageArgs[K] extends never ? [values?: never]
  : [values: { [P in keyof MessageArgs[K]]: MessageArgs[K][P] extends string ? MessageArgs[K][P] | AppError | LocalizedMessage : MessageArgs[K][P] }];
export type LocalizedMessage = { readonly key: MessageKey; readonly values?: DescriptorValues };
interface Settings {
  preference: LocalePreference;
  locale: Locale;
  revision: string;
  availableLocales: Locale[];
  warning?: string | null;
}
const listeners = new Set<() => void>();
const formats = new Map<string, IntlMessageFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();
const NUMBER_FORMAT_CACHE_LIMIT = 64;
const builtInDictionaries: Record<string, Record<string, string>> = catalog.messages;
let dictionaries: Record<string, Record<string, string>> = builtInDictionaries;
let localeDefinitions: Record<string, { displayName: string; fallback: string | null; direction: string }> = catalog.locales;
const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
export function matchLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const normalized = language.replace(/_/g, '-').split(/[.@]/)[0];
    const matched = Object.keys(localeDefinitions).find(code => code.toLowerCase() === normalized.toLowerCase());
    if (matched && matched !== 'en-XA') return matched as Locale;
    const parts = normalized.toLowerCase().split('-');
    const base = parts[0];
    // Prefer an explicit Chinese script over region; preserve distinct scripts.
    const script = parts.includes('hant') ? 'zh-Hant' : parts.includes('hans') ? 'zh-Hans'
      : parts.some(part => ['tw', 'hk', 'mo'].includes(part)) ? 'zh-Hant' : 'zh-Hans';
    const alias = base === 'zh' ? script : base === 'no' ? 'nb' : base;
    if (has(localeDefinitions, alias)) return alias;
    if (has(localeDefinitions, base) && base !== 'en-XA') return base;
  }
  return 'ja';
}
let settings: Settings = {
  preference: null, locale: 'ja', revision: '', availableLocales: Object.keys(localeDefinitions).filter(code => code !== 'en-XA')
};
export const getLocale = (): Locale => settings.locale;
export const getLocaleDirection = (): 'ltr' | 'rtl' => localeDefinitions[settings.locale]?.direction === 'rtl' ? 'rtl' : 'ltr';
export const getLocalePreference = (): LocalePreference => settings.preference;
export const getAvailableLocales = (): readonly Locale[] => settings.availableLocales;
export const getLocaleName = (locale: Locale): string => localeDefinitions[locale]?.displayName ?? locale;
export function subscribeLocale(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}
function applySettings(next: Settings) {
  if (!has(localeDefinitions, next.locale)) return;
  settings = next;
  document.documentElement.lang = next.locale === 'en-XA' ? 'en' : next.locale;
  document.documentElement.dir = localeDefinitions[next.locale].direction;
  for (const callback of listeners) { try { callback(); } catch (error) { console.warn('[i18n] Locale subscriber failed', error); } }
  void updateDialogTitle();
}
function candidates(locale: string): string[] {
  const result: string[] = [];
  let code: string | null = locale;
  while (code && !result.includes(code)) {
    result.push(code);
    code = localeDefinitions[code]?.fallback ?? null;
  }
  if (!result.includes('ja')) result.push('ja');
  return result;
}
function formatMessage(key: string, values: Values | undefined, locale: string = settings.locale): string {
  // A validated user catalog can predate newly bundled UI keys. Preserve its
  // complete locale/fallback preference first, then use the current built-in
  // catalog for missing strings. This never rewrites the user's settings tables.
  for (const [resource, messages] of [['runtime', dictionaries], ['embedded', builtInDictionaries]] as const) {
    for (const code of candidates(locale)) {
      if (!has(messages[code] ?? {}, key)) continue;
      const source = messages[code][key];
      try {
        const cacheKey = `${resource}\0${code}\0${key}`;
        let formatter = formats.get(cacheKey);
        if (!formatter) {
          formatter = new IntlMessageFormat(source, code === 'en-XA' ? 'en' : code, undefined, { ignoreTag: true });
          formats.set(cacheKey, formatter);
        }
        return String(formatter.format(values));
      } catch (error) {
        if (import.meta.env.DEV) console.warn(`[i18n] Could not format ${code}:${key}`, error);
      }
    }
  }
  // A damaged or incomplete optional resource must not prevent the editor from opening.
  return `[${key}]`;
}
export function t<K extends MessageKey>(key: K, ...args: Arguments<K>): string {
  return formatMessage(key, args[0] as Values | undefined);
}
export function message<K extends MessageKey>(key: K, ...args: DescriptorArguments<K>): LocalizedMessage {
  return { key, values: args[0] as DescriptorValues | undefined };
}
export class LocalizedError extends Error {
  readonly key: MessageKey;
  readonly values?: DescriptorValues;
  constructor(descriptor: LocalizedMessage) {
    super(descriptor.key);
    this.name = 'LocalizedError';
    this.key = descriptor.key;
    this.values = descriptor.values;
  }
}
export function localizedError(descriptor: LocalizedMessage): LocalizedError { return new LocalizedError(descriptor); }
function isAppError(error: unknown): error is AppError {
  if (!error || typeof error !== 'object' || !('kind' in error)) return false;
  if (error.kind === 'text') return 'text' in error && typeof error.text === 'string';
  if (error.kind === 'code') return 'code' in error && typeof error.code === 'string'
    && 'params' in error && error.params !== null && typeof error.params === 'object' && !Array.isArray(error.params);
  if (error.kind === 'diagnostics') return 'diagnostics' in error && Array.isArray(error.diagnostics)
    && error.diagnostics.every(value => isAppError(value) && (value.kind === 'text' || value.kind === 'code'));
  return error.kind === 'input_validation' && 'report' in error && error.report !== null
    && typeof error.report === 'object' && 'issues' in error.report && Array.isArray(error.report.issues);
}
/** Preserve error identity across plugin/native JSON boundaries without parsing text. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error && typeof error === 'object') {
    const value = error as { appError?: unknown; diagnostic?: unknown; key?: unknown; values?: DescriptorValues };
    if (isAppError(value.appError)) return value.appError;
    if (isAppError(value.diagnostic)) return value.diagnostic;
    if (typeof value.key === 'string') return { kind: 'code', code: value.key, params: value.values ?? {} };
  }
  return { kind: 'text', text: localizeError(error) };
}
export function appErrorException(error: unknown): Error & { readonly appError: AppError } {
  const appError = toAppError(error);
  return Object.assign(new Error(localizeError(appError)), { appError });
}

export function resolveMessage(value: string | LocalizedMessage | null | undefined): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : localizeError(value);
}
export function useI18n() {
  const snapshot = useSyncExternalStore(subscribeLocale, () => settings, () => settings);
  return { locale: snapshot.locale, preference: snapshot.preference, availableLocales: snapshot.availableLocales, t };
}
// Cache only plain data options. Accessors/custom prototypes keep native Intl
// evaluation and error behavior; non-finite option values must not alias null in JSON.
function numberFormatKey(locale: string, options?: Intl.NumberFormatOptions): string | undefined {
  const entries: Array<[string, unknown]> = [];
  if (options !== undefined) {
    if (options === null || typeof options !== 'object') return undefined;
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    for (const key of Object.getOwnPropertyNames(options).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key)!;
      if (!('value' in descriptor)) return undefined;
      const option = descriptor.value;
      if (option === undefined) continue;
      if (option !== null && typeof option !== 'string' && typeof option !== 'boolean'
        && (typeof option !== 'number' || !Number.isFinite(option))) return undefined;
      entries.push([key, Object.is(option, -0) ? ['number', '-0'] : option]);
    }
  }
  return JSON.stringify([locale, entries]);
}
export function formatNumber(value: number | bigint, options?: Intl.NumberFormatOptions): string {
  const locale = settings.locale === 'en-XA' ? 'en' : settings.locale;
  const key = numberFormatKey(locale, options);
  if (key === undefined) return new Intl.NumberFormat(locale, options).format(value);
  let formatter = numberFormats.get(key);
  if (formatter) {
    // Refresh recency; display-only caching never retains formatted cell values.
    numberFormats.delete(key);
  } else {
    // Construct before insertion so invalid options still throw on every call.
    formatter = new Intl.NumberFormat(locale, options);
  }
  numberFormats.set(key, formatter);
  if (numberFormats.size > NUMBER_FORMAT_CACHE_LIMIT) {
    numberFormats.delete(numberFormats.keys().next().value!);
  }
  return formatter.format(value);
}
export function formatDateTime(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return formatMessage('common.unknownDate', undefined);
  return new Intl.DateTimeFormat(settings.locale === 'en-XA' ? 'en' : settings.locale, options).format(date);
}
/** Decodes app-owned errors only. User messages and diagnostic details remain verbatim. */
export function localizeError(error: unknown): string { return decodeError(error, 0); }
function localizedValues(values: Record<string, unknown> | undefined, depth: number): Values | undefined {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([name, value]) => {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      // Only explicit app-owned descriptors can be nested; plain strings remain literal.
      const descriptor = value as { kind?: string; key?: unknown };
      if (['code', 'text', 'input_validation', 'diagnostics'].includes(descriptor.kind ?? '') || typeof descriptor.key === 'string') {
        return [name, decodeError(value, depth + 1)];
      }
    }
    return [name, value];
  })) as Values;
}
/** Structured native errors and user text have distinct, explicit variants. */
function decodeError(error: unknown, depth: number): string {
  if (depth > 8) return formatMessage('common.error', undefined);
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const value = error as { appError?: AppError; diagnostic?: Diagnostic; diagnostics?: Diagnostic[]; kind?: unknown; text?: unknown; code?: unknown;
      params?: Values; key?: unknown; values?: DescriptorValues; report?: { issues?: Array<{ diagnostic: Diagnostic }> } };
    if (value.appError) return decodeError(value.appError, depth + 1);
    if (value.kind === 'diagnostics' && Array.isArray(value.diagnostics)) return value.diagnostics.map(issue => decodeError(issue, depth + 1)).join('\n');
    if (value.diagnostic) return decodeError(value.diagnostic, depth + 1);
    if (value.kind === 'text' && typeof value.text === 'string') return value.text;
    if (value.kind === 'code' && typeof value.code === 'string') return formatMessage(value.code, localizedValues(value.params, depth));
    if (value.kind === 'input_validation' && Array.isArray(value.report?.issues)) {
      return value.report.issues.map(issue => decodeError(issue.diagnostic, depth + 1)).join('\n');
    }
    if (typeof value.key === 'string') return formatMessage(value.key, localizedValues(value.values, depth));
    if (error instanceof Error) return error.message;
    return formatMessage('common.error', undefined);
  }
  return String(error);
}

/** Runtime resources come only from a fully validated settings-project snapshot. */
export function applyRuntimeLocalization(resource: { messages: Record<string, Record<string, string>>; locales: Record<string, { displayName: string; fallback: string | null; direction: string }> }, next: Settings): void {
  dictionaries = resource.messages;
  localeDefinitions = resource.locales;
  formats.clear();
  numberFormats.clear();
  applySettings(next);
}
export async function initializeI18n(): Promise<void> {
  applySettings({ preference: null, locale: matchLocale(navigator.languages), revision: 'embedded', availableLocales: Object.keys(localeDefinitions).filter(code => code !== 'en-XA') });
}
const dialogTitles: Record<string, string> = {
  '/color_picker': 'color.title',
  '/project_create_wizard': 'window.projectCreate', '/project_edit_dialog': 'window.projectEdit',
  '/bulk_row_dialog': 'grid.bulk.title',
  '/table_rule_dialog': 'window.rules',
  '/export_dialog': 'window.export',
  '/plugin_manager': 'window.plugins', '/plugin_packages': 'window.pluginPackages', '/app_updater': 'window.updater'
};
async function updateDialogTitle() {
  const key = dialogTitles[window.location.pathname];
  if (!key) return; // The main title includes the user's project name and is owned by WindowHeader.
  const title = formatMessage(key, undefined);
  document.title = title;
  if (isTauri()) await getCurrentWindow().setTitle(title).catch(error => console.warn('[i18n] Window title update failed', error));
}

// Optional namespaced plugin dictionaries. Existing string labels remain unchanged.
const pluginDictionaries = new Map<string, Record<string, Record<string, string>>>();
type PluginTranslationTables = Record<string, Record<string, Record<string, string>>>;
let projectPluginDictionaries: PluginTranslationTables = (appCatalog as unknown as { pluginTranslations?: PluginTranslationTables }).pluginTranslations ?? {};
/** A native validated snapshot replaces all declarative dictionaries atomically. */
export function applyPluginTranslationTables(messages: PluginTranslationTables = {}) {
  projectPluginDictionaries = messages;
}
export function registerPluginMessages(namespace: string, messages: Record<string, Record<string, string>>): () => void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(namespace) || pluginDictionaries.has(namespace)) throw appErrorException({ kind: 'code', code: 'plugin.i18n.error.namespace', params: { owner: namespace } });
  const safe: Record<string, Record<string, string>> = Object.create(null);
  for (const [locale, entries] of Object.entries(messages)) {
    if (!has(localeDefinitions, locale)) throw appErrorException({ kind: 'code', code: 'plugin.i18n.error.locale', params: { owner: namespace, locale } });
    safe[locale] = Object.create(null);
    for (const [key, value] of Object.entries(entries)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key) || typeof value !== 'string') throw appErrorException({ kind: 'code', code: 'plugin.i18n.error.message', params: { owner: namespace, key } });
      if (Object.values(projectPluginDictionaries[namespace] ?? {}).some(entries => has(entries, key))) throw appErrorException({ kind: 'code', code: 'plugin.i18n.error.collision', params: { owner: namespace, key } });
      try {
        new IntlMessageFormat(value, locale === 'en-XA' ? 'en' : locale, undefined, { ignoreTag: true });
      } catch (error) {
        throw appErrorException({ kind: 'code', code: 'plugin.i18n.error.syntax', params: { owner: namespace, key, error: toAppError(error) } });
      }
      safe[locale][key] = value;
    }
  }
  pluginDictionaries.set(namespace, safe);
  return () => { if (pluginDictionaries.get(namespace) === safe) pluginDictionaries.delete(namespace); };
}
export function translatePluginMessage(namespace: string, key: string, values?: Values, fallback = key): string {
  const authored = has(projectPluginDictionaries, namespace) ? projectPluginDictionaries[namespace] : undefined;
  const runtime = pluginDictionaries.get(namespace);
  const locales = [...new Set([...candidates(settings.locale), 'en'])];
  for (const locale of locales) {
    const source = (authored?.[locale] && has(authored[locale], key) ? authored[locale][key] : undefined)
      ?? (runtime?.[locale] && has(runtime[locale], key) ? runtime[locale][key] : undefined);
    if (source === undefined) continue;
    try { return String(new IntlMessageFormat(source, locale === 'en-XA' ? 'en' : locale, undefined, { ignoreTag: true }).format(values)); }
    catch { /* preserve the existing plugin label when an optional message cannot be formatted */ }
  }
  return fallback;
}
