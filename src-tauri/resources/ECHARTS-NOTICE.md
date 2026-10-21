# ECharts (Apache-2.0)

- File: `echarts.min.js`
- Version: 5.5.1
- Upstream: https://github.com/apache/echarts
- License: Apache License 2.0 (the full license header is retained at the top of the file)

This file is inlined into generated HTML pages **only when the page contains `chart` blocks**,
so that the produced report stays a single offline file (no CDN / no network). Pages without
charts do not include it.

To update: replace `echarts.min.js` with the official `dist/echarts.min.js` of the same major
version and update the version number above.
