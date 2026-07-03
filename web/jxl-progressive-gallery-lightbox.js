export function createGalleryLightbox({ framesByFile }) {
  let state = null;
  let maxFrameIndexVisited = 0;
  let constancyParams = { mode: 'off', exposure: 0, saturation: 0, whiteBalance: [1, 1, 1] };
  let focusRegion = null;

  function updateVisited(index) {
    if (Number.isFinite(index) && index > maxFrameIndexVisited) {
      maxFrameIndexVisited = index;
    }
  }

  return {
    open(fileId, frameIndex) {
      state = { fileId, frameIndex };
      updateVisited(frameIndex);
    },
    current() {
      return state;
    },
    handleKey(ev) {
      if (!state) return;
      const frames = framesByFile.get(state.fileId) ?? [];
      if (frames.length === 0) return;

      const cur = state.frameIndex;
      let fileChanged = false;

      if (ev.ctrlKey && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
        const ids = [...framesByFile.keys()];
        const idx = ids.indexOf(state.fileId);
        let nextFile;

        if (ev.key === 'ArrowRight') {
          nextFile = ids[(idx + 1) % ids.length];
        } else {
          nextFile = ids[(idx - 1 + ids.length) % ids.length];
        }

        const nextFrames = framesByFile.get(nextFile) ?? [];
        const cap = Math.min(maxFrameIndexVisited, Math.max(0, nextFrames.length - 1));
        state = { fileId: nextFile, frameIndex: cap };
        fileChanged = true;
        return { navigated: true, fileChanged, state };
      }

      let nextIdx = cur;
      if (ev.key === 'ArrowRight') {
        nextIdx = (cur + 1) % frames.length;
        state = { fileId: state.fileId, frameIndex: nextIdx };
        // only raise on forward non-wrap (wrap right last->0 does not increase max)
        if (nextIdx > cur) updateVisited(nextIdx);
      } else if (ev.key === 'ArrowLeft') {
        nextIdx = (cur - 1 + frames.length) % frames.length;
        state = { fileId: state.fileId, frameIndex: nextIdx };
        if (nextIdx < cur) {
          // back or wrap left (0->last): do not grant via wrap
        } else {
          updateVisited(nextIdx);
        }
      }
      return { navigated: true, fileChanged, state };
    },
    setConstancyParams(p) {
      if (p && typeof p === 'object') {
        constancyParams = { ...constancyParams, ...p };
      }
    },
    getConstancyParams() {
      return { ...constancyParams };
    },
    setFocusRegion(roi) {
      focusRegion = roi && typeof roi === 'object' ? { ...roi } : null;
    },
    getFocusRegion() {
      return focusRegion ? { ...focusRegion } : null;
    },
    getAttended() {
      if (!state) return null;
      return {
        fileId: state.fileId,
        frameIndex: state.frameIndex,
        constancyParams: this.getConstancyParams(),
        focusRegion: this.getFocusRegion(),
      };
    },
  };
}
