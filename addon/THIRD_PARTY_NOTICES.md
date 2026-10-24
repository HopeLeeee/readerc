# Third-party notices

The bundled `data/lexicon.json` is a filtered and compacted derivative of ECDICT:

- Project: https://github.com/skywind3000/ECDICT
- Pinned revision: `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`
- Source file: `ecdict.csv`
- Project license: MIT; complete upstream notice in `licenses/ECDICT.txt`.
- Source credit: skywind3000/ECDICT contributors. Upstream license notice credits Linwei (2025).
- Transformations: lowercase single-word filtering, definition truncation, inflection index,
  FRQ/BNC ranking and compact JSON representation. No claims of CEFR equivalence.

ReaderC uses Zotero's documented plugin event interfaces and, for PDF text-layer
discovery, version-specific reader internals. Zotero is a separate application;
Zotero source code is not bundled in this plugin.
