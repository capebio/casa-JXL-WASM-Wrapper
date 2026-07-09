import { test, expect } from 'vitest';
import { RAW_ACCEPT, isRawFilename, stripRawExtension } from './raw-extensions.js';

test('raw filename filter admits native and LibRaw browser formats', () => {
  for (const name of [
    'olympus.ORF',
    'canon.CR2',
    'adobe.DNG',
    'nikon.NEF',
    'nikon.NRW',
    'canon.CR3',
    'canon.CRW',
    'panasonic.RW2',
    'leica.RWL',
    'sony.ARW',
    'fuji.RAF',
  ]) {
    expect(isRawFilename(name), name).toBe(true);
  }

  expect(isRawFilename('render.tif')).toBe(false);
  expect(isRawFilename('preview.jpg')).toBe(false);
});

test('raw accept string and stem stripping stay in sync with raw filename filter', () => {
  expect(RAW_ACCEPT).toContain('.nef');
  expect(RAW_ACCEPT).toContain('.NEF');
  expect(RAW_ACCEPT).toContain('.rw2');
  expect(RAW_ACCEPT).toContain('.RW2');
  expect(stripRawExtension('ADH 1234.CR2')).toBe('ADH 1234');
  expect(stripRawExtension('DSC_0001.NEF')).toBe('DSC_0001');
});
