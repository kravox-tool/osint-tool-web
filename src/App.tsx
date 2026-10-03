import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Search,
  Download,
  RefreshCw,
  ExternalLink,
  Copy,
  Check,
  Square,
  SlidersHorizontal,
  ArrowUpDown,
} from 'lucide-react';
import {
  PLATFORMS_DB,
  PLATFORM_CATEGORIES,
  PlatformCategory,
  PlatformEntry,
} from './data/platforms';
import {
  runAsyncBatchScan,
  runInitialValidationSuite,
  verifySinglePlatformOnDemand,
  ScanResultItem,
  ValidationTestItem,
  EngineMode,
} from './services/scannerEngine';
import {
  exportResultsToCSV,
  exportResultsToJSON,
  exportSherlockDatabaseJSON,
  downloadGitHubPagesWorkflow,
  GITHUB_PAGES_WORKFLOW_YAML,
} from './utils/exporters';

type ActiveSection = 'auditor' | 'validation' | 'catalog' | 'ghpages';
type StatusFilter = 'Todos' | 'Encontrado' | 'Disponible' | 'Error';
type SortField = 'id' | 'name' | 'status' | 'latencyMs' | 'httpCode';

const QUICK_SAMPLE_ALIASES = ['torvalds', 'midudev', 'octocat', 'vitalik', 'gaearon'];

export function App() {
  // Navigation state
  const [activeSection, setActiveSection] = useState<ActiveSection>('auditor');

  // Search & Scanner configuration state
  const [usernameInput, setUsernameInput] = useState<string>('torvalds');
  const [auditedUsername, setAuditedUsername] = useState<string>('torvalds');
  const [batchSize, setBatchSize] = useState<number>(25);
  const [engineMode, setEngineMode] = useState<EngineMode>('hybrid');

  // Scan execution state
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scannedCount, setScannedCount] = useState<number>(0);
  const [currentBatch, setCurrentBatch] = useState<number>(0);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [results, setResults] = useState<ScanResultItem[]>([]);
  const [recheckingId, setRecheckingId] = useState<number | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Table filtering & sorting state
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('Todos');
  const [categoryFilter, setCategoryFilter] = useState<PlatformCategory | 'Todas'>('Todas');
  const [tableQuery, setTableQuery] = useState<string>('');
  const [sortField, setSortField] = useState<SortField>('id');
  const [sortAsc, setSortAsc] = useState<boolean>(true);

  // Catalog search state
  const [catalogSearch, setCatalogSearch] = useState<string>('');
  const [catalogCategory, setCatalogCategory] = useState<PlatformCategory | 'Todas'>('Todas');

  // Initial Validation Suite (First 12 platforms in list)
  const [validationResults, setValidationResults] = useState<ValidationTestItem[]>([]);
  const [isValidating, setIsValidating] = useState<boolean>(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const scanTimerRef = useRef<number | null>(null);
  const scanStartTimestampRef = useRef<number>(0);

  const totalPlatforms = PLATFORMS_DB.length; // 300

  const copyToClipboard = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  }, []);

  // Execute validation check on the first platforms of the list
  const executeInitialValidation = useCallback(async (mode: EngineMode) => {
    setIsValidating(true);
    try {
      const items = await runInitialValidationSuite(PLATFORMS_DB, mode);
      setValidationResults(items);
    } finally {
      setIsValidating(false);
    }
  }, []);

  // Execute full 300-platform asynchronous batch scan
  const startAuditScan = useCallback(
    async (targetAlias: string, selectedBatchSize: number, selectedMode: EngineMode) => {
      const cleanAlias = targetAlias.trim().replace(/^@/, '');
      if (!cleanAlias) return;

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (scanTimerRef.current) {
        window.clearInterval(scanTimerRef.current);
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;

      setAuditedUsername(cleanAlias);
      setIsScanning(true);
      setScannedCount(0);
      setCurrentBatch(0);
      setElapsedMs(0);
      setResults([]);

      scanStartTimestampRef.current = performance.now();
      scanTimerRef.current = window.setInterval(() => {
        setElapsedMs(Math.round(performance.now() - scanStartTimestampRef.current));
      }, 90);

      try {
        await runAsyncBatchScan({
          username: cleanAlias,
          platforms: PLATFORMS_DB,
          batchSize: selectedBatchSize,
          mode: selectedMode,
          signal: controller.signal,
          onBatchResults: (batchItems, scannedSoFar, _total, batchNum) => {
            setResults((prev) => [...prev, ...batchItems]);
            setScannedCount(scannedSoFar);
            setCurrentBatch(batchNum);
          },
        });
      } finally {
        if (scanTimerRef.current) {
          window.clearInterval(scanTimerRef.current);
          scanTimerRef.current = null;
        }
        setElapsedMs(Math.round(performance.now() - scanStartTimestampRef.current));
        setIsScanning(false);
      }
    },
    []
  );

  const stopAuditScan = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (scanTimerRef.current) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    setIsScanning(false);
  }, []);

  // Re-verify a single platform row on demand
  const handleSingleRecheck = useCallback(
    async (platformId: number) => {
      const platform = PLATFORMS_DB.find((p) => p.id === platformId);
      if (!platform || !auditedUsername) return;

      setRecheckingId(platformId);
      try {
        const updated = await verifySinglePlatformOnDemand(auditedUsername, platform, engineMode);
        setResults((prev) =>
          prev.map((item) => (item.id === platformId ? { ...updated, batchIndex: item.batchIndex } : item))
        );
      } finally {
        setRecheckingId(null);
      }
    },
    [auditedUsername, engineMode]
  );

  // Auto-initialize validation of first platforms + initial 300-platform scan on mount
  useEffect(() => {
    executeInitialValidation('hybrid');
    startAuditScan('torvalds', 25, 'hybrid');
    return () => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
      if (scanTimerRef.current) window.clearInterval(scanTimerRef.current);
    };
  }, [executeInitialValidation, startAuditScan]);

  // Real-time aggregated metrics
  const metrics = useMemo(() => {
    let found = 0;
    let available = 0;
    let error = 0;
    let totalLatency = 0;

    for (const r of results) {
      if (r.status === 'Encontrado') found++;
      else if (r.status === 'Disponible') available++;
      else if (r.status === 'Error') error++;
      totalLatency += r.latencyMs;
    }

    const avgLatency = results.length > 0 ? Math.round(totalLatency / results.length) : 0;
    const progressPercent = Math.min(100, Math.round((scannedCount / totalPlatforms) * 100));

    return {
      found,
      available,
      error,
      avgLatency,
      progressPercent,
      totalBatches: Math.ceil(totalPlatforms / batchSize),
    };
  }, [results, scannedCount, totalPlatforms, batchSize]);

  // Filtered and sorted results for the main audit table
  const filteredResults = useMemo(() => {
    const q = tableQuery.trim().toLowerCase();

    const filtered = results.filter((item) => {
      if (statusFilter !== 'Todos' && item.status !== statusFilter) return false;
      if (categoryFilter !== 'Todas' && item.category !== categoryFilter) return false;
      if (q) {
        const matchName = item.name.toLowerCase().includes(q);
        const matchUrl = item.targetUrl.toLowerCase().includes(q);
        const matchCat = item.category.toLowerCase().includes(q);
        const matchCode = String(item.httpCode).includes(q);
        if (!matchName && !matchUrl && !matchCat && !matchCode) return false;
      }
      return true;
    });

    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'id') cmp = a.id - b.id;
      else if (sortField === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortField === 'status') cmp = a.status.localeCompare(b.status);
      else if (sortField === 'latencyMs') cmp = a.latencyMs - b.latencyMs;
      else if (sortField === 'httpCode') cmp = a.httpCode - b.httpCode;
      return sortAsc ? cmp : -cmp;
    });
  }, [results, statusFilter, categoryFilter, tableQuery, sortField, sortAsc]);

  // Filtered catalog entries
  const filteredCatalog = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();
    return PLATFORMS_DB.filter((p) => {
      if (catalogCategory !== 'Todas' && p.category !== catalogCategory) return false;
      if (q) {
        return (
          p.name.toLowerCase().includes(q) ||
          p.urlTemplate.toLowerCase().includes(q) ||
          p.category.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [catalogSearch, catalogCategory]);

  const handleSortClick = (field: SortField) => {
    if (sortField === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    startAuditScan(usernameInput, batchSize, engineMode);
  };

  const handleAuditFromCatalog = (platform: PlatformEntry) => {
    setUsernameInput(platform.claimedUser);
    setActiveSection('auditor');
    startAuditScan(platform.claimedUser, batchSize, engineMode);
  };

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      {/* =====================================================================
          TOP BAR CONTRACT: Strict 3-Zone Header
          Zone 1: Single wordmark | Zone 2: 4 Nav Links | Zone 3: 2 Export Actions
         ===================================================================== */}
      <header className="sticky top-0 z-30 bg-[#0B0F17]/95 backdrop-blur border-b border-slate-800/80 px-6 py-3.5">
        <div className="max-w-[1360px] mx-auto flex items-center justify-between gap-6">
          {/* Zone 1: Single text element wordmark */}
          <a
            href="#auditor"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('auditor');
            }}
            className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-emerald-500"
          >
            Osint tool
          </a>

          {/* Zone 2: 4 clean navigation links */}
          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-400">
            <button
              type="button"
              onClick={() => setActiveSection('auditor')}
              className={`py-1 transition-colors whitespace-nowrap border-b-2 ${
                activeSection === 'auditor'
                  ? 'text-slate-100 border-emerald-500'
                  : 'border-transparent hover:text-slate-200'
              }`}
            >
              Auditoría de Alias
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('validation')}
              className={`py-1 transition-colors whitespace-nowrap border-b-2 ${
                activeSection === 'validation'
                  ? 'text-slate-100 border-emerald-500'
                  : 'border-transparent hover:text-slate-200'
              }`}
            >
              Validación Inicial
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('catalog')}
              className={`py-1 transition-colors whitespace-nowrap border-b-2 ${
                activeSection === 'catalog'
                  ? 'text-slate-100 border-emerald-500'
                  : 'border-transparent hover:text-slate-200'
              }`}
            >
              Base de Datos (300)
            </button>
            <button
              type="button"
              onClick={() => setActiveSection('ghpages')}
              className={`py-1 transition-colors whitespace-nowrap border-b-2 ${
                activeSection === 'ghpages'
                  ? 'text-slate-100 border-emerald-500'
                  : 'border-transparent hover:text-slate-200'
              }`}
            >
              GitHub Pages
            </button>
          </nav>

          {/* Zone 3: 2 Primary Export Actions */}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={results.length === 0}
              onClick={() => exportResultsToCSV(auditedUsername, filteredResults.length > 0 ? filteredResults : results)}
              className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-slate-800/90 border border-slate-700/80 rounded-lg hover:bg-slate-700/80 transition-colors whitespace-nowrap disabled:opacity-40 flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Exportar CSV
            </button>
            <button
              type="button"
              disabled={results.length === 0}
              onClick={() =>
                exportResultsToJSON(
                  auditedUsername,
                  filteredResults.length > 0 ? filteredResults : results,
                  elapsedMs,
                  engineMode
                )
              }
              className="px-3.5 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 rounded-lg hover:bg-emerald-300 transition-colors whitespace-nowrap disabled:opacity-40 flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Exportar JSON
            </button>
          </div>
        </div>

        {/* Mobile Navigation Strip */}
        <div className="flex md:hidden items-center gap-2 pt-3 mt-3 border-t border-slate-800/80 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveSection('auditor')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              activeSection === 'auditor' ? 'bg-slate-800 text-slate-100' : 'text-slate-400'
            }`}
          >
            Auditoría
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('validation')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              activeSection === 'validation' ? 'bg-slate-800 text-slate-100' : 'text-slate-400'
            }`}
          >
            Validación Inicial
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('catalog')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              activeSection === 'catalog' ? 'bg-slate-800 text-slate-100' : 'text-slate-400'
            }`}
          >
            300 Plataformas
          </button>
          <button
            type="button"
            onClick={() => setActiveSection('ghpages')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              activeSection === 'ghpages' ? 'bg-slate-800 text-slate-100' : 'text-slate-400'
            }`}
          >
            GitHub Pages
          </button>
        </div>
      </header>

      {/* =====================================================================
          MAIN WORKSPACE CANVAS (1360px container, single-elevation depth)
         ===================================================================== */}
      <main className="flex-1 max-w-[1360px] w-full mx-auto px-6 py-8 space-y-8">
        {/* ===================================================================
            VIEW 1: AUDITORÍA DE ALIAS (MOTOR DE ESCANEO ASÍNCRONO + TABLA)
           =================================================================== */}
        {activeSection === 'auditor' && (
          <>
            {/* Hero & Central Search Bar */}
            <section className="bg-[#111724] border border-slate-800/90 rounded-xl p-6 md:p-8 space-y-6">
              <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
                <div className="space-y-2 max-w-2xl">
                  <div className="flex items-center gap-2 text-xs text-slate-400 font-mono tabular-nums">
                    <span>Arquitectura tipo Sherlock</span>
                    <span aria-hidden="true">·</span>
                    <span>300 Plataformas Públicas</span>
                    <span aria-hidden="true">·</span>
                    <span>Escaneo Asíncrono por Lotes</span>
                  </div>
                  <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-100 text-balance">
                    Auditoría de Presencia Digital y Verificación de Alias
                  </h1>
                </div>

                {/* Engine Mode & Concurrency Controls */}
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setEngineMode('hybrid')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                        engineMode === 'hybrid'
                          ? 'bg-slate-800 text-slate-100'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Motor Unificado (API + CORS)
                    </button>
                    <button
                      type="button"
                      onClick={() => setEngineMode('github_pages')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                        engineMode === 'github_pages'
                          ? 'bg-slate-800 text-slate-100'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Modo GitHub Pages (Cliente)
                    </button>
                  </div>

                  <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-slate-800 rounded-lg">
                    {[15, 25, 50].map((size) => (
                      <button
                        key={size}
                        type="button"
                        onClick={() => setBatchSize(size)}
                        className={`px-2.5 py-1.5 text-xs font-mono tabular-nums rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                          batchSize === size
                            ? 'bg-slate-800 text-emerald-400 font-semibold'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Lote: {size}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Central Search Form */}
              <form onSubmit={handleSearchSubmit} className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                    placeholder="Introduce el nombre de usuario o alias a auditar (ej. torvalds, midudev)..."
                    aria-label="Nombre de usuario a auditar"
                    className="w-full pl-11 pr-4 py-3 bg-[#0B0F17] border border-slate-700/90 rounded-lg text-sm text-slate-100 placeholder:text-slate-500 font-mono focus:outline-none focus:border-emerald-400 transition-colors"
                  />
                </div>

                {isScanning ? (
                  <button
                    type="button"
                    onClick={stopAuditScan}
                    className="px-6 py-3 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition-colors whitespace-nowrap flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <Square className="w-4 h-4 fill-current" />
                    Detener Escaneo
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="px-6 py-3 text-sm font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors whitespace-nowrap flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <Search className="w-4 h-4" />
                    Auditar 300 Plataformas
                  </button>
                )}
              </form>

              {/* Quick Sample Alias Triggers + Validation Status Summary */}
              <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-slate-800/80 text-xs text-slate-400">
                <div className="flex flex-wrap items-center gap-2">
                  <span>Alias de prueba rápida:</span>
                  {QUICK_SAMPLE_ALIASES.map((sample) => (
                    <button
                      key={sample}
                      type="button"
                      onClick={() => {
                        setUsernameInput(sample);
                        startAuditScan(sample, batchSize, engineMode);
                      }}
                      className={`px-2.5 py-1 font-mono rounded-md border transition-colors cursor-pointer ${
                        auditedUsername.toLowerCase() === sample
                          ? 'bg-slate-800 border-emerald-500/60 text-emerald-300'
                          : 'bg-[#0B0F17] border-slate-800 text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      @{sample}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2 font-mono tabular-nums text-slate-400">
                  <span>
                    Validación inicial (12 primeras plataformas):{' '}
                    <strong className="text-emerald-400">
                      {validationResults.filter((v) => v.passed).length}/{validationResults.length || 12} superadas
                    </strong>
                  </span>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={() => setActiveSection('validation')}
                    className="text-slate-200 underline hover:text-emerald-400 cursor-pointer"
                  >
                    Ver diagnóstico HTTP
                  </button>
                </div>
              </div>
            </section>

            {/* Real-Time Progress & Telemetry Strip (Tabular Numerals) */}
            <section className="bg-[#111724] border border-slate-800/90 rounded-xl p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="text-xs text-slate-400">
                    Objetivo activo:{' '}
                    <span className="font-mono font-semibold text-slate-100">@{auditedUsername}</span>
                    <span className="mx-2" aria-hidden="true">
                      ·
                    </span>
                    <span>
                      Lote actual:{' '}
                      <span className="font-mono tabular-nums text-slate-200">
                        {currentBatch} / {metrics.totalBatches}
                      </span>
                    </span>
                    <span className="mx-2" aria-hidden="true">
                      ·
                    </span>
                    <span>
                      Tiempo:{' '}
                      <span className="font-mono tabular-nums text-slate-200">
                        {(elapsedMs / 1000).toFixed(2)}s
                      </span>
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-3 font-mono tabular-nums text-sm">
                  <span className="text-slate-400">Plataformas escaneadas:</span>
                  <span className="text-lg font-bold text-slate-100">
                    {scannedCount} / {totalPlatforms}
                  </span>
                  <span className="text-emerald-400 font-semibold">({metrics.progressPercent}%)</span>
                </div>
              </div>

              {/* Compositor-friendly Progress Bar */}
              <div className="w-full h-2 bg-[#0B0F17] rounded-full overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-emerald-400 origin-left transition-transform duration-150 ease-out"
                  style={{ transform: `scaleX(${metrics.progressPercent / 100})` }}
                />
              </div>

              {/* 4-Column Stat Grid separated by hairline dividers */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 pt-2 border-t border-slate-800/80">
                <div>
                  <div className="text-xs text-slate-400">Encontrado (HTTP 200 OK)</div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-2xl font-bold font-mono tabular-nums text-emerald-400">
                      {metrics.found}
                    </span>
                    <span className="text-xs font-mono tabular-nums text-slate-400">
                      perfiles activos
                    </span>
                  </div>
                </div>

                <div className="lg:border-l lg:border-slate-800/80 lg:pl-6">
                  <div className="text-xs text-slate-400">Disponible (HTTP 404 Not Found)</div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-2xl font-bold font-mono tabular-nums text-slate-200">
                      {metrics.available}
                    </span>
                    <span className="text-xs font-mono tabular-nums text-slate-400">
                      alias libres
                    </span>
                  </div>
                </div>

                <div className="lg:border-l lg:border-slate-800/80 lg:pl-6">
                  <div className="text-xs text-slate-400">Error (HTTP 403 / 429 / Timeout)</div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-2xl font-bold font-mono tabular-nums text-amber-400">
                      {metrics.error}
                    </span>
                    <span className="text-xs font-mono tabular-nums text-slate-400">
                      protegidos por WAF
                    </span>
                  </div>
                </div>

                <div className="lg:border-l lg:border-slate-800/80 lg:pl-6">
                  <div className="text-xs text-slate-400">Latencia Media por Lote</div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-2xl font-bold font-mono tabular-nums text-slate-100">
                      {metrics.avgLatency} ms
                    </span>
                    <span className="text-xs font-mono tabular-nums text-slate-400">
                      {batchSize} req/lote
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {/* Filter Bar & High-Density Results Table */}
            <section className="bg-[#111724] border border-slate-800/90 rounded-xl overflow-hidden">
              {/* Table Controls Header */}
              <div className="p-5 border-b border-slate-800/90 space-y-4">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  {/* Status Segmented Filter Controls */}
                  <div className="flex flex-wrap items-center gap-1.5 p-1 bg-[#0B0F17] border border-slate-800 rounded-lg">
                    {(
                      [
                        { id: 'Todos', count: results.length, label: 'Todos' },
                        { id: 'Encontrado', count: metrics.found, label: 'Encontrado (200)' },
                        { id: 'Disponible', count: metrics.available, label: 'Disponible (404)' },
                        { id: 'Error', count: metrics.error, label: 'Error (WAF/Timeout)' },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setStatusFilter(tab.id)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer font-mono tabular-nums ${
                          statusFilter === tab.id
                            ? 'bg-slate-800 text-slate-100 shadow-xs'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {tab.label}: {tab.count}
                      </button>
                    ))}
                  </div>

                  {/* Secondary Filters: Category Selector & Text Filter */}
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <SlidersHorizontal className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <select
                        value={categoryFilter}
                        onChange={(e) =>
                          setCategoryFilter(e.target.value as PlatformCategory | 'Todas')
                        }
                        aria-label="Filtrar por categoría"
                        className="bg-[#0B0F17] border border-slate-700/80 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-400"
                      >
                        <option value="Todas">Todas las categorías (12)</option>
                        {PLATFORM_CATEGORIES.map((cat) => (
                          <option key={cat} value={cat}>
                            {cat}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="relative min-w-[220px]">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={tableQuery}
                        onChange={(e) => setTableQuery(e.target.value)}
                        placeholder="Filtrar por plataforma, URL o código..."
                        className="w-full pl-8 pr-3 py-2 bg-[#0B0F17] border border-slate-700/80 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-400"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* High-Density Data Grid */}
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800/90 bg-[#0B0F17]/60 text-xs font-medium text-slate-400">
                      <th className="py-3 px-4 w-16">
                        <button
                          type="button"
                          onClick={() => handleSortClick('id')}
                          className="flex items-center gap-1 hover:text-slate-200 cursor-pointer font-mono"
                        >
                          #
                          <ArrowUpDown className="w-3 h-3" />
                        </button>
                      </th>
                      <th className="py-3 px-4">
                        <button
                          type="button"
                          onClick={() => handleSortClick('name')}
                          className="flex items-center gap-1 hover:text-slate-200 cursor-pointer"
                        >
                          Plataforma y Categoría
                          <ArrowUpDown className="w-3 h-3" />
                        </button>
                      </th>
                      <th className="py-3 px-4">
                        <button
                          type="button"
                          onClick={() => handleSortClick('status')}
                          className="flex items-center gap-1 hover:text-slate-200 cursor-pointer"
                        >
                          Estado de Verificación
                          <ArrowUpDown className="w-3 h-3" />
                        </button>
                      </th>
                      <th className="py-3 px-4">URL de Perfil Verificada</th>
                      <th className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => handleSortClick('httpCode')}
                          className="flex items-center justify-end gap-1 ml-auto hover:text-slate-200 cursor-pointer"
                        >
                          Respuesta HTTP
                          <ArrowUpDown className="w-3 h-3" />
                        </button>
                      </th>
                      <th className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => handleSortClick('latencyMs')}
                          className="flex items-center justify-end gap-1 ml-auto hover:text-slate-200 cursor-pointer"
                        >
                          Latencia
                          <ArrowUpDown className="w-3 h-3" />
                        </button>
                      </th>
                      <th className="py-3 px-4 text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-sm">
                    {filteredResults.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-12 px-6 text-center text-slate-400">
                          {isScanning ? (
                            <span className="font-mono text-xs">
                              Ejecutando lotes asíncronos para @{auditedUsername}...
                            </span>
                          ) : (
                            <div className="space-y-2">
                              <p className="text-sm text-slate-300">
                                No hay registros que coincidan con el filtro seleccionado.
                              </p>
                              <button
                                type="button"
                                onClick={() => {
                                  setStatusFilter('Todos');
                                  setCategoryFilter('Todas');
                                  setTableQuery('');
                                }}
                                className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 rounded-md hover:bg-slate-700 cursor-pointer"
                              >
                                Restablecer filtros
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : (
                      filteredResults.map((row) => (
                        <tr
                          key={row.id}
                          className="hover:bg-slate-800/35 transition-colors group"
                        >
                          <td className="py-2.5 px-4 font-mono tabular-nums text-xs text-slate-400">
                            {String(row.id).padStart(3, '0')}
                          </td>
                          <td className="py-2.5 px-4">
                            <div className="font-medium text-slate-100">{row.name}</div>
                            <div className="text-xs text-slate-400">
                              <span>{row.category}</span>
                              <span className="mx-1.5" aria-hidden="true">
                                ·
                              </span>
                              <span className="font-mono">{row.method}</span>
                            </div>
                          </td>
                          <td className="py-2.5 px-4 font-mono text-xs whitespace-nowrap">
                            {row.status === 'Encontrado' && (
                              <span className="text-emerald-400 font-semibold">
                                ENCONTRADO · Perfil Activo
                              </span>
                            )}
                            {row.status === 'Disponible' && (
                              <span className="text-slate-400">
                                DISPONIBLE · No Registrado
                              </span>
                            )}
                            {row.status === 'Error' && (
                              <span className="text-amber-400 font-medium">
                                ERROR · WAF / Timeout
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-4 max-w-[320px]">
                            <a
                              href={row.targetUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-xs text-slate-300 hover:text-emerald-400 truncate block transition-colors"
                              title={row.targetUrl}
                            >
                              {row.targetUrl}
                            </a>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums text-xs whitespace-nowrap">
                            <span
                              className={
                                row.httpCode === 200
                                  ? 'text-emerald-400'
                                  : row.httpCode === 404
                                  ? 'text-slate-400'
                                  : 'text-amber-400'
                              }
                            >
                              {row.statusText}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums text-xs text-slate-300 whitespace-nowrap">
                            {row.latencyMs} ms
                          </td>
                          <td className="py-2.5 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => handleSingleRecheck(row.id)}
                                disabled={recheckingId === row.id}
                                title="Re-verificar esta plataforma"
                                className="p-1.5 text-slate-400 hover:text-slate-100 rounded hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-40"
                              >
                                <RefreshCw
                                  className={`w-3.5 h-3.5 ${
                                    recheckingId === row.id ? 'animate-spin text-emerald-400' : ''
                                  }`}
                                />
                              </button>
                              <button
                                type="button"
                                onClick={() => copyToClipboard(row.targetUrl, `url-${row.id}`)}
                                title="Copiar URL de verificación"
                                className="p-1.5 text-slate-400 hover:text-slate-100 rounded hover:bg-slate-800 transition-colors cursor-pointer"
                              >
                                {copiedKey === `url-${row.id}` ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                              <a
                                href={row.targetUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Abrir perfil en pestaña nueva"
                                className="p-1.5 text-slate-400 hover:text-emerald-400 rounded hover:bg-slate-800 transition-colors"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Table Footer Summary */}
              <div className="px-5 py-3.5 border-t border-slate-800/90 bg-[#0B0F17]/50 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400 font-mono tabular-nums">
                <div>
                  Mostrando {filteredResults.length} de {results.length} plataformas verificadas (Objetivo total: {totalPlatforms})
                </div>
                <div className="flex items-center gap-4">
                  <span>Lote concurrente: {batchSize} promesas</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Modo: {engineMode === 'hybrid' ? 'Unificado Backend + CORS' : 'Estático GitHub Pages'}
                  </span>
                </div>
              </div>
            </section>
          </>
        )}

        {/* ===================================================================
            VIEW 2: VALIDACIÓN DE ENTORNO CON LAS PRIMERAS PLATAFORMAS
           =================================================================== */}
        {activeSection === 'validation' && (
          <section className="bg-[#111724] border border-slate-800/90 rounded-xl p-6 md:p-8 space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800/80">
              <div className="space-y-1.5 max-w-2xl">
                <div className="text-xs text-slate-400 font-mono">
                  Diagnóstico de Ejecución · Primeras 12 Plataformas de la Lista
                </div>
                <h2 className="text-xl md:text-2xl font-bold text-slate-100">
                  Comprobación de Validez del Motor Asíncrono (HTTP 200 vs HTTP 404)
                </h2>
                <p className="text-sm text-slate-400">
                  Prueba automatizada contra las primeras plataformas de la base de datos alternando alias reales conocidos (esperado 200 OK) y alias sintéticos inexistentes (esperado 404 Not Found).
                </p>
              </div>

              <button
                type="button"
                onClick={() => executeInitialValidation(engineMode)}
                disabled={isValidating}
                className="px-4 py-2.5 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors whitespace-nowrap flex items-center gap-2 self-start cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isValidating ? 'animate-spin' : ''}`} />
                Re-ejecutar Validación Inicial
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0B0F17]/60">
                    <th className="py-3 px-4 font-mono">#</th>
                    <th className="py-3 px-4">Plataforma</th>
                    <th className="py-3 px-4">Alias de Prueba</th>
                    <th className="py-3 px-4">URL Evaluada</th>
                    <th className="py-3 px-4">Resultado Esperado</th>
                    <th className="py-3 px-4">Respuesta Obtenida</th>
                    <th className="py-3 px-4 text-right">Latencia</th>
                    <th className="py-3 px-4 text-right">Veredicto</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-sm">
                  {validationResults.map((item) => (
                    <tr key={item.platformId} className="hover:bg-slate-800/30">
                      <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-400">
                        {String(item.platformId).padStart(2, '0')}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-100">{item.platformName}</div>
                        <div className="text-xs text-slate-400">
                          {item.category} · {item.mechanism}
                        </div>
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-200">
                        @{item.testedUsername}
                      </td>
                      <td className="py-3 px-4 max-w-[260px]">
                        <a
                          href={item.targetUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs text-slate-400 hover:text-emerald-400 truncate block"
                        >
                          {item.targetUrl}
                        </a>
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-300">
                        {item.expectedStatus === 'Encontrado'
                          ? 'Encontrado (200 OK)'
                          : 'Disponible (404)'}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-xs">
                        <span
                          className={
                            item.httpCode === 200 ? 'text-emerald-400' : 'text-slate-300'
                          }
                        >
                          {item.actualStatus} (HTTP {item.httpCode})
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-slate-300">
                        {item.latencyMs} ms
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-xs font-semibold">
                        {item.passed ? (
                          <span className="text-emerald-400">VALIDADO</span>
                        ) : (
                          <span className="text-amber-400">DIFERENCIA</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ===================================================================
            VIEW 3: BASE DE DATOS DE 300 PLATAFORMAS (ESTRUCTURA SHERLOCK)
           =================================================================== */}
        {activeSection === 'catalog' && (
          <section className="bg-[#111724] border border-slate-800/90 rounded-xl p-6 md:p-8 space-y-6">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-6 border-b border-slate-800/80">
              <div className="space-y-1.5 max-w-2xl">
                <div className="text-xs text-slate-400 font-mono tabular-nums">
                  Esquema Compatible con Sherlock · 300 Plataformas Públicas Indexadas
                </div>
                <h2 className="text-xl md:text-2xl font-bold text-slate-100">
                  Directorio de Redes Sociales, Desarrollo, Foros y Comunidades
                </h2>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => exportSherlockDatabaseJSON(PLATFORMS_DB)}
                  className="px-4 py-2 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors whitespace-nowrap flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  Descargar JSON de 300 Plataformas
                </button>
              </div>
            </div>

            {/* Filter controls for the 300 platforms catalog */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <select
                  value={catalogCategory}
                  onChange={(e) =>
                    setCatalogCategory(e.target.value as PlatformCategory | 'Todas')
                  }
                  aria-label="Filtrar catálogo por categoría"
                  className="bg-[#0B0F17] border border-slate-700/80 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-400"
                >
                  <option value="Todas">Todas las categorías (300 plataformas)</option>
                  {PLATFORM_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat} ({PLATFORMS_DB.filter((p) => p.category === cat).length})
                    </option>
                  ))}
                </select>
              </div>

              <div className="relative flex-1 max-w-md">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={catalogSearch}
                  onChange={(e) => setCatalogSearch(e.target.value)}
                  placeholder="Buscar plataforma o patrón de URL en las 300 entradas..."
                  className="w-full pl-8 pr-3 py-2 bg-[#0B0F17] border border-slate-700/80 rounded-lg text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-400"
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 text-xs font-medium text-slate-400 bg-[#0B0F17]/60">
                    <th className="py-3 px-4 font-mono">ID</th>
                    <th className="py-3 px-4">Plataforma</th>
                    <th className="py-3 px-4">Categoría</th>
                    <th className="py-3 px-4">URL Base de Verificación</th>
                    <th className="py-3 px-4">Mecanismo</th>
                    <th className="py-3 px-4">Cuenta Test</th>
                    <th className="py-3 px-4 text-right">Probar</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-sm">
                  {filteredCatalog.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-800/30">
                      <td className="py-2.5 px-4 font-mono tabular-nums text-xs text-slate-400">
                        {String(item.id).padStart(3, '0')}
                      </td>
                      <td className="py-2.5 px-4 font-medium text-slate-100">{item.name}</td>
                      <td className="py-2.5 px-4 text-xs text-slate-400">{item.category}</td>
                      <td className="py-2.5 px-4 font-mono text-xs text-slate-300">
                        {item.urlTemplate}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-xs text-slate-400">
                        {item.errorType}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-xs text-emerald-400">
                        @{item.claimedUser}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => handleAuditFromCatalog(item)}
                          className="px-2.5 py-1 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded transition-colors cursor-pointer whitespace-nowrap"
                        >
                          Auditar @{item.claimedUser}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ===================================================================
            VIEW 4: DESPLIEGUE EN GITHUB PAGES
           =================================================================== */}
        {activeSection === 'ghpages' && (
          <section className="bg-[#111724] border border-slate-800/90 rounded-xl p-6 md:p-8 space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800/80">
              <div className="space-y-1.5 max-w-2xl">
                <div className="text-xs text-slate-400 font-mono">
                  Configuración Lista para Producción · Compatible con GitHub Pages y Backend Unificado
                </div>
                <h2 className="text-xl md:text-2xl font-bold text-slate-100">
                  Despliegue de Osint tool en GitHub Pages
                </h2>
                <p className="text-sm text-slate-400">
                  El proyecto está configurado con rutas relativas (<code className="text-slate-200">base: './'</code> en Vite) y conmutación automática al motor cliente CORS cuando se aloja estáticamente en GitHub Pages.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={downloadGitHubPagesWorkflow}
                  className="px-4 py-2.5 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors whitespace-nowrap flex items-center gap-2 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  Descargar deploy-github-pages.yml
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="space-y-4">
                <h3 className="text-base font-semibold text-slate-100">
                  01. Arquitectura Dual (Full-Stack + Estático)
                </h3>
                <p className="text-sm text-slate-400 leading-relaxed">
                  En entornos con servidor Node.js, <code className="text-slate-200">server.ts</code> procesa los lotes mediante peticiones HTTP directas. Al compilar para GitHub Pages (<code className="text-slate-200">npm run build</code>), la aplicación opera automáticamente desde el navegador usando APIs públicas con CORS y trabajadores concurrentes.
                </p>

                <h3 className="text-base font-semibold text-slate-100 pt-2">
                  02. Pasos para Publicar en tu Repositorio
                </h3>
                <ol className="text-sm text-slate-300 space-y-2 list-decimal list-inside">
                  <li>Sube el código a tu repositorio en GitHub.</li>
                  <li>
                    El archivo <code className="text-emerald-400 text-xs">.github/workflows/deploy-github-pages.yml</code> ya está incluido en el proyecto.
                  </li>
                  <li>
                    En GitHub, abre <strong>Settings → Pages → Build and deployment</strong> y selecciona <strong>GitHub Actions</strong> como fuente.
                  </li>
                </ol>
              </div>

              <div className="lg:col-span-2 space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-400 font-mono">
                  <span>.github/workflows/deploy-github-pages.yml</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(GITHUB_PAGES_WORKFLOW_YAML, 'gh-yaml')}
                    className="text-slate-300 hover:text-emerald-400 flex items-center gap-1 cursor-pointer"
                  >
                    {copiedKey === 'gh-yaml' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        Copiado
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        Copiar YAML
                      </>
                    )}
                  </button>
                </div>
                <pre className="p-4 bg-[#0B0F17] border border-slate-800 rounded-lg text-xs text-slate-300 font-mono overflow-x-auto leading-relaxed">
                  {GITHUB_PAGES_WORKFLOW_YAML}
                </pre>
              </div>
            </div>
          </section>
        )}
      </main>

      {/* Quiet Footer (No telemetry tickers, strictly clean links & copyright) */}
      <footer className="border-t border-slate-800/80 py-6 px-6 text-xs text-slate-500">
        <div className="max-w-[1360px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            Osint tool — Auditoría de Presencia Digital y Verificación Asíncrona en 300 Plataformas Públicas
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => exportSherlockDatabaseJSON(PLATFORMS_DB)}
              className="hover:text-slate-300 transition-colors cursor-pointer"
            >
              Esquema JSON (300)
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => setActiveSection('ghpages')}
              className="hover:text-slate-300 transition-colors cursor-pointer"
            >
              Configuración GitHub Pages
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
