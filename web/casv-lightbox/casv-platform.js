// casv-platform — runtime adapter for the CASAVA lightbox.
//
// One UI, two hosts:
//   • Browser  — decode/showcase + export (download) an existing .casv.
//                Encoding is unavailable (the casa_video codec is native-only).
//   • Tauri    — additionally: native image picker, native .casv encode
//                (invoke 'encode_casv_video'), and native save-to-disk.
//
// Detection is by presence of the Tauri global; everything else degrades
// gracefully so the same page works when opened as a plain web page.

import { createDecoder } from '@casabio/jxl-wasm';

export function isTauri() {
  return typeof window !== 'undefined' &&
    !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
}

function tauriInvoke(cmd, args) {
  const t = window.__TAURI__ || {};
  // Tauri v2: __TAURI__.core.invoke ; v1: __TAURI__.invoke / __TAURI__.tauri.invoke
  const invoke = t.core?.invoke || t.invoke || t.tauri?.invoke ||
    window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') {
    return Promise.reject(new Error('Tauri invoke() unavailable in this build'));
  }
  return invoke(cmd, args);
}

/**
 * Browser one-shot JXL frame decoder, matching the JxlFrameDecoder contract
 * casv-web's playCasv() expects: (bytes) => Promise<{rgba, width, height}>.
 * Uses the same createDecoder path the progressive gallery uses.
 */
export function makeBrowserJxlDecoder() {
  return async (jxl) => {
    const decoder = createDecoder({
      format: 'rgba8',
      region: null,
      downsample: 1,
      progressionTarget: 'final',
      emitEveryPass: false,
      preserveIcc: false,
      preserveMetadata: false,
    });
    decoder.push(jxl.slice()); // defensive copy: facade may transfer the buffer
    decoder.close();
    for await (const ev of decoder.events()) {
      if (ev.type === 'error') throw new Error(ev.message);
      if (ev.type === 'final') {
        const px = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
        return { rgba: px.slice(), width: ev.info.width, height: ev.info.height };
      }
    }
    throw new Error('decoder produced no final frame');
  };
}

/** Pick a single .casv file. Browser: <input>; returns a File (or null). */
export function pickCasvFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.casv,application/octet-stream';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0] ? input.files[0] : null;
      input.remove();
      resolve(f);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Pick image files to encode into a .casv.
 * Tauri: native open dialog → absolute paths (what the encoder needs).
 * Browser: returns { native:false } — encoding is native-only, so the UI
 * shows the disabled state rather than pretending it can encode.
 */
export async function pickImagesToEncode() {
  if (isTauri()) {
    // Prefer the Tauri dialog plugin if present; else a dedicated command.
    const dialog = window.__TAURI__?.dialog;
    let paths = null;
    if (dialog?.open) {
      paths = await dialog.open({
        multiple: true,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'ppm', 'jxl'] }],
      });
    } else {
      paths = await tauriInvoke('pick_image_paths', {});
    }
    const arr = Array.isArray(paths) ? paths : paths ? [paths] : [];
    return { native: true, paths: arr };
  }
  return { native: false, paths: [] };
}

/**
 * Encode + save a .casv from picked images. Tauri only.
 * `request` is the object from buildEncodeRequest(). The native command
 * reads the input images, encodes via casa_video::encode_casv_video, and
 * (if request.outputPath is null) opens a save dialog. Returns { path }.
 */
export async function encodeAndSave(request) {
  if (!isTauri()) {
    const e = new Error(
      'CASAVA encoding needs the desktop app (the codec is native-only). ' +
      'This browser build can decode, showcase and export existing .casv files.'
    );
    e.code = 'ENCODE_NATIVE_ONLY';
    throw e;
  }
  return tauriInvoke('encode_casv_video', { request });
}

/**
 * Export the currently-loaded .casv bytes.
 * Tauri: native save dialog + write (command 'save_casv_bytes').
 * Browser: anchor download.
 * Returns { path, method }.
 */
export async function exportCasv(bytes, suggestedName) {
  if (isTauri()) {
    const path = await tauriInvoke('save_casv_bytes', {
      bytes: Array.from(bytes),
      suggestedName,
    });
    return { path: path || suggestedName, method: 'tauri' };
  }
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { path: suggestedName, method: 'download' };
}
