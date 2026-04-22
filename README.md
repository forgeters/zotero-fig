# Zotero Fig

Zotero Fig is a Zotero 7-9 plugin for detecting figures and tables in PDF
attachments, showing them in the reader side pane, and supporting quick
navigation and enlarged preview.

This project is based on
[windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template).

## Development

Install dependencies:

```powershell
npm install
```

Configure the Zotero executable and development profile:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` and set:

- `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`
- `ZOTERO_PLUGIN_PROFILE_PATH`

Start the hot-reload development server:

```powershell
npm start
```

Build the plugin:

```powershell
npm run build
```

The packaged XPI is written to `.scaffold/build/zotero-fig.xpi`.

## Roadmap

1. Clean the template and set up project metadata.
2. Add a reader-side figures and tables panel.
3. Detect figure and table captions from PDF text content.
4. Add navigation from the side panel to PDF locations.
5. Add thumbnail extraction and cached detection results.
6. Add enlarged preview for detected figure and table regions.
