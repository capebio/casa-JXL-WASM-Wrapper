"""Score `nef_libraw_sweep`'s planes against LibRaw, per sample.

    python tools/nef_libraw_compare.py <sweep.tsv> <pgmdir> <corpus-root>

Prints one line per file and a count summary. Counts, never percentages of a
denominator that moves.

TRAPS THIS AVOIDS, all paid for by someone already:

- `rawpy`'s `raw_image` is a VIEW into LibRaw's buffer. Read it after the `with`
  block closes and you are reading freed memory -- it produced "50.00% differ"
  where only ~100% was possible, and a segfault. The `.copy()` here is inside.
- `raw_image_visible` drops the sensor margins this reader keeps. Twelve files
  read as 61-99% divergent for that reason alone and were all exact against
  `raw_image`.
"""
import os
import sys

import numpy as np
import rawpy


def read_pgm16(path):
    with open(path, "rb") as f:
        d = f.read()
    # P5\n<w> <h>\n<maxval>\n, then w*h big-endian u16.
    parts, i = [], 2
    while len(parts) < 3:
        while i < len(d) and d[i : i + 1].isspace():
            i += 1
        if d[i : i + 1] == b"#":
            while i < len(d) and d[i] != 0x0A:
                i += 1
            continue
        j = i
        while j < len(d) and not d[j : j + 1].isspace():
            j += 1
        parts.append(int(d[i:j]))
        i = j
    i += 1
    w, h, _ = parts
    a = np.frombuffer(d, dtype=">u2", count=w * h, offset=i)
    return a.reshape(h, w).astype(np.uint16)


def oracle(path):
    """`(raw_image, rows LibRaw actually fills)`.

    LibRaw allocates `raw_height` rows but only writes the ones the sensor's
    margins plus the visible frame cover, so the tail can be an untouched block
    of zeros. On `nikon_1-aw1_DSC0521` that is the last 2 of 3084 rows, and
    counting them made an otherwise sample-exact file read as 9,240 differing
    samples. Zeros LibRaw never wrote are not evidence about this reader.
    """
    with rawpy.imread(path) as r:
        # copy INSIDE the with; raw_image is a view into LibRaw's buffer
        return r.raw_image.copy(), r.sizes.top_margin + r.sizes.height


def main(tsv, pgmdir, root):
    index = {}
    for dirpath, _, names in os.walk(root):
        for n in names:
            if n.lower().endswith((".nef", ".nrw")):
                index[os.path.splitext(n)[0]] = os.path.join(dirpath, n)

    # The TSV is captured from a `cargo run`, so build chatter and the header
    # line are in it too. A data row has 10 fields and a name in the corpus.
    rows = [l.rstrip("\n").split("\t") for l in open(tsv, encoding="utf-8")]
    rows = [r for r in rows if len(r) == 10 and r[0] in index]
    n_decode = n_exact = n_oracleless = 0
    refused = []
    print(
        "%-46s %-9s %-11s %-11s %s"
        % ("file", "verdict", "ours", "libraw", "differing / compared")
    )
    for r in rows:
        name, status = r[0], r[1]
        if status != "ok":
            refused.append((name, status))
            print("%-46s %s" % (name[:46], status))
            continue
        n_decode += 1
        pgm = os.path.join(pgmdir, name + ".pgm")
        ours = read_pgm16(pgm)
        src = index.get(name)
        try:
            ref, filled = oracle(src)
        except Exception as e:
            n_oracleless += 1
            print("%-46s %-9s %-11s no-oracle (%s)" % (name[:46], "?", "%dx%d" % (ours.shape[1], ours.shape[0]), e))
            continue
        h, w = ours.shape
        if ref.shape[0] < h or ref.shape[1] < w:
            print(
                "%-46s %-9s %-11s %-11s SHAPE: oracle is smaller"
                % (name[:46], "SHAPE", "%dx%d" % (w, h), "%dx%d" % (ref.shape[1], ref.shape[0]))
            )
            continue
        # The reader lays samples out from the start of the strip, margins
        # included, so the top-left of raw_image is the aligned window -- but
        # only over the rows LibRaw actually filled.
        cmp_h = min(h, filled)
        sub = ref[:cmp_h, :w].astype(np.int32)
        diff = np.count_nonzero(sub != ours[:cmp_h].astype(np.int32))
        if diff == 0:
            n_exact += 1
        note = "" if cmp_h == h else "  (%d trailing rows LibRaw leaves unwritten)" % (h - cmp_h)
        print(
            "%-46s %-9s %-11s %-11s %d / %d%s"
            % (
                name[:46],
                "EXACT" if diff == 0 else "differs",
                "%dx%d" % (w, h),
                "%dx%d" % (ref.shape[1], ref.shape[0]),
                diff,
                cmp_h * w,
                note,
            )
        )

    print()
    print("files swept          %d" % len(rows))
    print("decoded              %d" % n_decode)
    print("refused              %d" % len(refused))
    print("sample-exact         %d" % n_exact)
    print("no LibRaw oracle     %d" % n_oracleless)


if __name__ == "__main__":
    main(*sys.argv[1:4])
