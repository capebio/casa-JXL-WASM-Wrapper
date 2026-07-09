export const RAW_EXTENSIONS = Object.freeze([
  'orf',
  'dng',
  'cr2',
  'raw',
  'arw',
  'srf',
  'sr2',
  'arq',
  'nef',
  'nrw',
  'rw2',
  'rwl',
  'crw',
  'cr3',
  'raf',
  'pef',
  'srw',
  'x3f',
  '3fr',
  'fff',
  'iiq',
]);

export const LIBRAW_RAW_EXTENSIONS = Object.freeze([
  'arw',
  'srf',
  'sr2',
  'arq',
  'nef',
  'nrw',
  'rw2',
  'rwl',
  'crw',
  'cr3',
  'raf',
  'pef',
  'srw',
  'x3f',
  '3fr',
  'fff',
  'iiq',
]);

function extensionPattern(exts) {
  return new RegExp('\\.(' + exts.join('|') + ')$', 'i');
}

export const RAW_EXTENSION_PATTERN = extensionPattern(RAW_EXTENSIONS);
export const LIBRAW_RAW_EXTENSION_PATTERN = extensionPattern(LIBRAW_RAW_EXTENSIONS);
export const RAW_ACCEPT = RAW_EXTENSIONS.flatMap((ext) => ['.' + ext, '.' + ext.toUpperCase()]).join(',');

export function isRawFilename(name = '') {
  return RAW_EXTENSION_PATTERN.test(String(name));
}

export function stripRawExtension(name = '') {
  return String(name).replace(RAW_EXTENSION_PATTERN, '');
}
