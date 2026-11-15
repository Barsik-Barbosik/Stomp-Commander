# Test fixtures

Not in the repository. The tests load these files from here:

| File | Used by | Where from |
|---|---|---|
| `DrumBox.ZDL`, `Floppy.ZDL`, `SongBox.ZDL` | zdl, ui, g1list, ms | [Custom-Zoom-ZDL-Effects](https://github.com/Barsik-Barbosik/Custom-Zoom-ZDL-Effects) `dist/` |
| `drumbox-screen.png` | zdl | the same repository, `src/drumbox/screen.png` |
| `g1xon/files/*.ZDL` | zdl, ui | every file of a G1Xon (fw 1.21), copied from the pedal |
| `g1xon/fs_a5000.bin` | zdl, pedal | flash backup of the same G1Xon's file system |
| `g1xon/FLST_SEQ_20261025.ZDT` | pedal | that pedal's effect list |

`python -m http.server` must list `g1xon/files/` as a directory page (the tests
read the file names from it).
