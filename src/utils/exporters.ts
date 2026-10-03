import { PlatformEntry } from '../data/platforms';
import { ScanResultItem } from '../services/scannerEngine';

function triggerDownload(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportResultsToJSON(
  username: string,
  results: ScanResultItem[],
  elapsedMs: number,
  mode: string
) {
  const foundCount = results.filter((r) => r.status === 'Encontrado').length;
  const availableCount = results.filter((r) => r.status === 'Disponible').length;
  const errorCount = results.filter((r) => r.status === 'Error').length;

  const reportPayload = {
    tool: 'Osint tool — Auditoría de Presencia Digital y Verificación de Alias',
    schemaVersion: '1.0.0',
    auditMetadata: {
      targetUsername: username,
      exportedAt: new Date().toISOString(),
      engineMode: mode,
      totalPlatformsScanned: results.length,
      elapsedTimeMs: elapsedMs,
      summary: {
        encontrado_200_ok: foundCount,
        disponible_404_not_found: availableCount,
        error_waf_timeout: errorCount,
      },
    },
    results: results.map((item) => ({
      id: item.id,
      platform: item.name,
      category: item.category,
      status: item.status,
      httpCode: item.httpCode,
      statusText: item.statusText,
      profileUrl: item.targetUrl,
      latencyMs: item.latencyMs,
      verificationMethod: item.method,
      batchNumber: item.batchIndex,
      checkedAt: item.timestamp,
    })),
  };

  const safeUser = username.replace(/[^a-zA-Z0-9_-]/g, '_') || 'alias';
  triggerDownload(
    JSON.stringify(reportPayload, null, 2),
    `osint-tool-reporte-${safeUser}.json`,
    'application/json;charset=utf-8;'
  );
}

export function exportResultsToCSV(username: string, results: ScanResultItem[]) {
  const headers = [
    'ID',
    'Plataforma',
    'Categoria',
    'Alias_Auditado',
    'Estado',
    'Codigo_HTTP',
    'Detalle_HTTP',
    'URL_Verificacion',
    'Latencia_ms',
    'Metodo_Deteccion',
    'Lote',
    'Timestamp_ISO',
  ];

  const escapeCsv = (val: string | number) => {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = results.map((r) =>
    [
      r.id,
      r.name,
      r.category,
      username,
      r.status,
      r.httpCode,
      r.statusText,
      r.targetUrl,
      r.latencyMs,
      r.method,
      r.batchIndex,
      r.timestamp,
    ]
      .map(escapeCsv)
      .join(',')
  );

  const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\n');
  const safeUser = username.replace(/[^a-zA-Z0-9_-]/g, '_') || 'alias';
  triggerDownload(
    csvContent,
    `osint-tool-reporte-${safeUser}.csv`,
    'text/csv;charset=utf-8;'
  );
}

export function exportSherlockDatabaseJSON(platforms: PlatformEntry[]) {
  const sherlockFormat: Record<string, unknown> = {};
  for (const p of platforms) {
    sherlockFormat[p.name] = {
      id: p.id,
      category: p.category,
      url: p.urlTemplate,
      urlMain: p.urlMain,
      errorType: p.errorType,
      ...(p.errorMsg ? { errorMsg: p.errorMsg } : {}),
      ...(p.apiTemplate ? { apiProbe: p.apiTemplate } : {}),
      username_claimed: p.claimedUser,
    };
  }

  triggerDownload(
    JSON.stringify(sherlockFormat, null, 2),
    'osint-tool-300-platforms.json',
    'application/json;charset=utf-8;'
  );
}

export const GITHUB_PAGES_WORKFLOW_YAML = `name: Deploy Osint tool to GitHub Pages

on:
  push:
    branches: ["main", "master"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js 20
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install dependencies
        run: npm install

      - name: Build static bundle for GitHub Pages
        run: npm run build

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist

  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;

export function downloadGitHubPagesWorkflow() {
  triggerDownload(
    GITHUB_PAGES_WORKFLOW_YAML,
    'deploy-github-pages.yml',
    'text/yaml;charset=utf-8;'
  );
}
