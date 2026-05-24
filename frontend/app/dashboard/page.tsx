"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { Upload, Database, Settings, BarChart2, Trash2, Play, FileText, Info, X } from "lucide-react";



const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

const InfoTooltip = ({ text }: { text: string }) => (
  <div className="relative group inline-flex items-center ml-1">
    <Info size={12} className="text-slate-400 cursor-help hover:text-primary transition-colors" />
    <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none w-48 p-2 bg-slate-800 text-slate-200 text-[10px] leading-tight rounded-md shadow-xl z-50 text-center normal-case tracking-normal">
      {text}
      <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800"></div>
    </div>
  </div>
);

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("ingestion");

  // -- Data Ingestion State --
  // FIX: importType now includes "spot" and "signal"
  const [importType, setImportType] = useState<"options" | "indicator" | "spot" | "signal">("options");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");

  // FIX: Separate header arrays per import type — shared state caused cross-form pollution
  const [optionsHeaders, setOptionsHeaders] = useState<string[]>([]);
  const [indicatorHeaders, setIndicatorHeaders] = useState<string[]>([]);
  const [spotHeaders, setSpotHeaders] = useState<string[]>([]);
  const [signalHeaders, setSignalHeaders] = useState<string[]>([]);
  const activeHeaders = importType === "options" ? optionsHeaders : importType === "indicator" ? indicatorHeaders : importType === "signal" ? signalHeaders : spotHeaders;

  // -- Options Import State --
  const [optionsMap, setOptionsMap] = useState({
    dateTime: "", date: "", time: "", open: "", high: "", low: "", close: "", volume: "", script: "",
    exchange: "NSE", exchangeOther: "",
    stock: "NIFTY", stockOther: "",
    type: "Call", typeOther: "",
    expiry: "",
    updatedBy: "",
    startDate: "", endDate: "", startTime: "", endTime: "",
  });


  // -- Indicator Import State --
  // KNOWN BUG FIXED: initial indicator value MUST match a real <option> value.
  // If it's "", browser shows the first option visually but state stays ""
  // causing indicatorName to be sent as empty string → NULL db insert.
  const [indicatorMap, setIndicatorMap] = useState({
    indicator: "RSI", indicatorOther: "",
    dateTime: "", date: "", time: "", open: "", high: "", low: "", close: "", volume: "", buy: "", sell: "",
    exchange: "NSE", exchangeOther: "",
    stock: "NIFTY", stockOther: "",
    updatedBy: "", // New field from requirements
    startDate: "", endDate: "", startTime: "", endTime: "",
    timeframe: "1m",
  });


  // -- Spot Data Import State --
  const [spotMap, setSpotMap] = useState({
    dateTime: "", date: "", time: "", price: "",
    stock: "NIFTY", stockOther: "",
    startDate: "", endDate: "", startTime: "", endTime: "",
    timeframe: "1m",
  });

  // -- Signal Data Import State --
  const [signalMap, setSignalMap] = useState({
    signal_provider: "", signal_providerOther: "",
    // Note: signal files have separate date + time columns; backend merges them into dateTime.
    // dateTime mapping is intentionally omitted — only date + time columns are mapped.
    date: "", time: "",
    startDate: "", endDate: "", startTime: "", endTime: "",
    // exchange/stock: static dropdown = filter selector. exchangeCol/stockCol = file column mapper.
    // If file column mapped → backend filters rows by selected value (no override).
    // If not mapped → selected value used as fallback constant for all rows.
    exchange: "NSE", exchangeOther: "", exchangeCol: "",
    stock: "NIFTY", stockOther: "", stockCol: "",
    script: "",
    type: "", ceValue: "", peValue: "",
    expiry: "",
    trade_type: "",
    signal: "", buyValue: "", sellValue: "",
    entry_type_col: "", entry_type_static: "Buy At",
    entry_price: "",
    sl: "", sl_type: "Points",
    target_1: "", tp_type: "Points",
    target_2: "", target_3: "", target_4: "", target_5: "",
    target_6: "", target_7: "", target_8: "", target_9: "", target_10: "",
    updatedBy: "",
    extraTargetCount: 0,
  });


  // -- Preview & Fallback State --
  const [previewData, setPreviewData] = useState<any[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [manualScript, setManualScript] = useState("");
  const [uniqueDates, setUniqueDates] = useState<string[]>([]);
  const [uniqueTimes, setUniqueTimes] = useState<string[]>([]);
  // Display-only: shows the actual date/time range found in the file.
  // NEVER written to filter state — filters stay empty unless user explicitly selects a value.
  // KNOWN BUG FIXED: Previously, auto-populate wrote min_time/max_time into
  // startTime/endTime filter state, causing rows to be silently dropped during
  // ingestion even when the user selected no filter.
  // REUSABLE: Separate display state from active filter state for any file-import form.
  const [previewRange, setPreviewRange] = useState({ minDate: "", maxDate: "", minTime: "", maxTime: "" });

  // -- Validator Config State --
  // KNOWN BUG FIXED: stock was missing from valConfig — it was incorrectly
  // set to valConfig.indicator (e.g. 'RSI') in the payload, causing zero DB matches.
  const [valConfig, setValConfig] = useState({
    indicator: "",
    stock: "NIFTY",           // stock for DB query — must match indicatordata.stock
    startDate: "", endDate: "",
    optionType: "Call",       // "Call" or "Put"
    script: "ATM+",
    atmOffset: "100",
    entrySignal: "Buy", exitSignal: "Sell",
    entryTime: "Next Candle", exitTime: "At Signal",
    applyOn: "Call",          // "Call", "Put", "Both"
    executionPrice: "Close",  // "Open", "High", "Low", "Close"
    tradeAmountType: "Capital",  // "Capital", "Lots", "None"
    tradeAmountLots: "50000",     // Text box value (used for both capital amount and lots amount)
    repetitiveSignals: "Ignore repetitive Signals", // "Ignore repetitive Signals", "Add Qty"
    positionOpenEndDate: "",  // Date
    positionOpenEndAction: "Ignore last Entry", // "Ignore last Entry", "Take next Entry beyond End Date"
    timeframe: "1m",
  });

  // FIX: Dynamic indicator list fetched from DB, not hardcoded RSI/MACD
  const [indicatorOptions, setIndicatorOptions] = useState<string[]>([]);
  const [signalProviderOptions, setSignalProviderOptions] = useState<string[]>([]);

  const [clearDb, setClearDb] = useState<{
    open: boolean;
    tables: { name: string; rowCount: number; hasUpdatedOn?: boolean; hasExpiry?: boolean; hasType?: boolean }[];
    selected: string;
    loading: boolean;
    result: string;
    timestamps: string[];
    selectedTimestamp: string;
    expiries: string[];
    selectedExpiry: string;
    types: string[];
    selectedType: string;
  }>({
    open: false,
    tables: [],
    selected: "",
    loading: false,
    result: "",
    timestamps: [],
    selectedTimestamp: "",
    expiries: [],
    selectedExpiry: "",
    types: [],
    selectedType: "",
  });

  const [validatorStatus, setValidatorStatus] = useState("");

  // -- Results State --
  const [report, setReport] = useState<any>(null);
  // Sort state for Trade Log table
  const [sortCol, setSortCol] = useState<string>("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  // Trade Verify Modal state
  const [verifyTrade, setVerifyTrade] = useState<any>(null);
  const [verifyOHLC, setVerifyOHLC] = useState<any[]>([]);
  const [verifyLoading, setVerifyLoading] = useState(false);
  // Reports history list
  const [reportsList, setReportsList] = useState<any[]>([]);
  // Copy-to-clipboard feedback
  const [copied, setCopied] = useState(false);

  // ATM Multiples: 50 to 2000 in multiples of 50 (per requirement spec)
  const atmMultiples = Array.from({ length: 40 }, (_, i) => String((i + 1) * 50));

  // ── Sorted trades (client-side) ──────────────────────────────────────────
  const sortedTrades = (() => {
    if (!report?.trades?.length) return [];
    const arr = [...report.trades];
    if (!sortCol) return arr;
    return arr.sort((a: any, b: any) => {
      const av = a[sortCol], bv = b[sortCol];
      if (typeof av === "number") return sortDir === "asc" ? av - bv : bv - av;
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
  })();

  const handleSort = (col: string) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };

  // ── Trade Verify Modal ────────────────────────────────────────────────────
  const handleVerify = async (trade: any) => {
    setVerifyTrade(trade);
    setVerifyOHLC([]);
    setVerifyLoading(true);
    try {
      const res = await fetch(
        `http://127.0.0.1:8000/api/options-data?script=${encodeURIComponent(trade.script)}&from_dt=${trade.entryTime}&to_dt=${trade.exitTime}`
      );
      const data = await res.json();
      setVerifyOHLC(Array.isArray(data) ? data : []);
    } catch { setVerifyOHLC([]); }
    finally { setVerifyLoading(false); }
  };

  // ── Export handlers ───────────────────────────────────────────────────────
  const handleExport = async (format: "csv" | "pdf") => {
    if (!report?.reportId) return;
    const res = await fetch(`http://127.0.0.1:8000/api/results/export?resultId=${report.reportId}&format=${format}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const cd = res.headers.get("Content-Disposition") || "";
    const name = cd.split("filename=")[1]?.replace(/"/g, "") || `Backtest.${format}`;
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopySummary = () => {
    if (!report) return;
    const text = [
      `📊 Backtest Summary`,
      `Stock:         ${report.stock || "—"}`,
      `Indicator:     ${report.indicatorName || "—"}`,
      `Net P&L:       ${report.totalProfit} pts`,
      `Win Rate:      ${report.winRate}%`,
      `Total Trades:  ${report.totalTrades}`,
      `Max Drawdown:  ${report.maxDrawdown}%`,
      `Profit Factor: ${report.profitFactor}x`,
      `Avg Trade:     ${report.avgTrade} pts`,
    ].join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Load historical report ────────────────────────────────────────────────
  const handleLoadReport = async (id: string) => {
    if (!id) return;
    try {
      const res = await fetch(`http://127.0.0.1:8000/api/results/${id}`);
      const data = await res.json();
      setReport(data);
    } catch { }
  };

  // Fetch reports list when Results tab is opened
  useEffect(() => {
    if (activeTab === "results") {
      fetch("http://127.0.0.1:8000/api/results")
        .then(r => r.json())
        .then(d => { if (Array.isArray(d)) setReportsList(d); })
        .catch(() => { });
    }
  }, [activeTab]);

  // FIX: stores headers in per-type arrays, not a single shared array
  // FIX: Reset date/time filters on every new file selection so stale date range
  // from a previously ingested file does not filter out all rows of the new file.
  // Without this, uploading File B after File A would apply File A's date range
  // to File B, causing "No records to insert after filtering" error.
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    setSelectedFile(file);

    // Reset date/time range for all import types so auto-populate always
    // reads fresh min/max values from the newly selected file
    const dateReset = { startDate: "", endDate: "", startTime: "", endTime: "" };
    setOptionsMap(prev => ({ ...prev, ...dateReset }));
    setIndicatorMap(prev => ({ ...prev, ...dateReset }));
    setSpotMap(prev => ({ ...prev, ...dateReset }));
    setSignalMap(prev => ({ ...prev, ...dateReset }));
    setIsUploading(true);
    setUploadStatus("Extracting headers...");
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("http://127.0.0.1:8000/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (data.headers) {
        if (importType === "options") setOptionsHeaders(data.headers);
        else if (importType === "indicator") setIndicatorHeaders(data.headers);
        else if (importType === "signal") setSignalHeaders(data.headers);
        else setSpotHeaders(data.headers);
        setUploadStatus("✓ Headers extracted. Map columns below.");
      } else {
        setUploadStatus("Error: " + (data.error || "Could not extract headers."));
      }
    } catch {
      setUploadStatus("Failed to contact backend. Ensure uvicorn is running.");
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemoveFile = () => {
    setSelectedFile(null);
    setUploadStatus("");
    setPreviewData([]);
    setUniqueDates([]);
    setUniqueTimes([]);
    setPreviewRange({ minDate: "", maxDate: "", minTime: "", maxTime: "" });
    setOptionsHeaders([]);
    setIndicatorHeaders([]);
    setSpotHeaders([]);
    setSignalHeaders([]);

    // Reset date/time filters to ensure a clean state for the next file
    const dateReset = { startDate: "", endDate: "", startTime: "", endTime: "" };
    setOptionsMap(prev => ({ ...prev, ...dateReset }));
    setIndicatorMap(prev => ({ ...prev, ...dateReset }));
    setSpotMap(prev => ({ ...prev, ...dateReset }));
    setSignalMap(prev => ({ ...prev, dateTime: "", date: "", time: "", script: "", type: "", expiry: "", trade_type: "", signal: "", entry_type_col: "", entry_price: "", sl: "", target_1: "", target_2: "", target_3: "", target_4: "", target_5: "", target_6: "", target_7: "", target_8: "", target_9: "", target_10: "" }));
  };

  // FIX: real POST /api/ingest — no more setTimeout mock
  const handleIngestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) { setUploadStatus("Please select a file first."); return; }
    if (importType === "signal") {
      handleSignalIngestSubmit(e);
      return;
    }

    setUploadStatus("Ingesting data...");
    const fd = new FormData();
    fd.append("file", selectedFile);
    fd.append("dataType", importType);
    let mappings: Record<string, string> = {};
    let stock = "", exchange = "", optionType = "", expiry = "", indicatorName = "", startDate = "", endDate = "", startTime = "", endTime = "";
    if (importType === "options") {
      const m = optionsMap;
      if (m.dateTime) mappings[m.dateTime] = "dateTime"; if (m.date) mappings[m.date] = "date"; if (m.time) mappings[m.time] = "time";
      if (m.open) mappings[m.open] = "open"; if (m.high) mappings[m.high] = "high"; if (m.low) mappings[m.low] = "low";
      if (m.close) mappings[m.close] = "close"; if (m.volume) mappings[m.volume] = "volume"; if (m.script) mappings[m.script] = "script";
      exchange = m.exchange === "Other" ? m.exchangeOther : m.exchange;
      stock = m.stock === "Other" ? m.stockOther : m.stock;
      optionType = m.type === "Other" ? m.typeOther : m.type;
      expiry = m.expiry; startDate = m.startDate; endDate = m.endDate; startTime = m.startTime; endTime = m.endTime;
    } else if (importType === "indicator") {
      const m = indicatorMap;
      if (m.dateTime) mappings[m.dateTime] = "dateTime"; if (m.date) mappings[m.date] = "date"; if (m.time) mappings[m.time] = "time";
      if (m.open) mappings[m.open] = "open"; if (m.high) mappings[m.high] = "high"; if (m.low) mappings[m.low] = "low";
      if (m.close) mappings[m.close] = "close"; if (m.volume) mappings[m.volume] = "volume";
      if (m.buy) mappings[m.buy] = "buySignal"; if (m.sell) mappings[m.sell] = "sellSignal";
      exchange = m.exchange === "Other" ? m.exchangeOther : m.exchange;
      stock = m.stock === "Other" ? m.stockOther : m.stock;
      indicatorName = m.indicator === "Other" ? m.indicatorOther : m.indicator;
      startDate = m.startDate; endDate = m.endDate; startTime = m.startTime; endTime = m.endTime;
    }
    const clean = Object.fromEntries(Object.entries(mappings).filter(([k, v]) => k && v));
    fd.append("mappings", JSON.stringify(clean));
    if (exchange) fd.append("exchange", exchange);
    if (stock) fd.append("stock", stock);
    if (optionType) fd.append("optionType", optionType);
    if (expiry) fd.append("expiry", expiry);
    if (indicatorName) fd.append("indicatorName", indicatorName);
    if (startDate) fd.append("startDate", startDate);
    if (endDate) fd.append("endDate", endDate);
    if (startTime) fd.append("startTime", startTime);
    if (endTime) fd.append("endTime", endTime);
    const timeframe = importType === "indicator" ? indicatorMap.timeframe : null;
    if (timeframe) fd.append("timeframe", timeframe);
    if (importType === "indicator" && indicatorMap.updatedBy) fd.append("updatedBy", indicatorMap.updatedBy);
    if (importType === "options" && optionsMap.updatedBy) fd.append("updatedBy", optionsMap.updatedBy);

    try {
      const res = await fetch("http://127.0.0.1:8000/api/ingest", { method: "POST", body: fd });
      const data = await res.json();
      setUploadStatus(data.error ? "Error: " + data.error : data.message);
      if (!data.error) {
        // Refresh indicator list after successful ingestion
        fetch("http://127.0.0.1:8000/api/indicators")
          .then(r => r.json())
          .then(d => { if (Array.isArray(d.indicators)) setIndicatorOptions(d.indicators); });
      }
    } catch { setUploadStatus("Failed to contact backend. Ensure uvicorn is running."); }
  };

  const handleSignalIngestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) { setUploadStatus("Please select a file first."); return; }
    const provider = signalMap.signal_provider === "Other" ? signalMap.signal_providerOther : signalMap.signal_provider;
    if (!provider) { setUploadStatus("Please enter a Signal Source Name."); return; }

    setUploadStatus("Ingesting signal data...");
    const fd = new FormData();
    fd.append("file", selectedFile);
    fd.append("signal_provider", provider);

    const m = signalMap;
    const mappings: Record<string, string> = {};
    // Signal files always have separate Date + Time columns — no combined dateTime mapping.
    if (m.date) mappings[m.date] = "date";
    if (m.time) mappings[m.time] = "time";
    // Map Exchange/Stock columns from file if the user selected a header for them
    if (m.exchangeCol) mappings[m.exchangeCol] = "exchange";
    if (m.stockCol) mappings[m.stockCol] = "stock";
    if (m.script) mappings[m.script] = "script";
    if (m.type) mappings[m.type] = "type";
    if (m.expiry) mappings[m.expiry] = "expiry";
    if (m.trade_type) mappings[m.trade_type] = "trade_type";
    if (m.signal) mappings[m.signal] = "signal";
    if (m.entry_type_col) mappings[m.entry_type_col] = "entry_type";
    if (m.entry_price) mappings[m.entry_price] = "entry_price";
    if (m.sl) mappings[m.sl] = "sl";
    if (m.target_1) mappings[m.target_1] = "target_1";
    if (m.target_2) mappings[m.target_2] = "target_2";
    if (m.target_3) mappings[m.target_3] = "target_3";
    if (m.target_4) mappings[m.target_4] = "target_4";
    if (m.target_5) mappings[m.target_5] = "target_5";
    if (m.target_6) mappings[m.target_6] = "target_6";
    if (m.target_7) mappings[m.target_7] = "target_7";
    if (m.target_8) mappings[m.target_8] = "target_8";
    if (m.target_9) mappings[m.target_9] = "target_9";
    if (m.target_10) mappings[m.target_10] = "target_10";

    const cleanMappings = Object.fromEntries(Object.entries(mappings).filter(([k, v]) => k && v));
    fd.append("mappings", JSON.stringify(cleanMappings));

    const exchange = m.exchange === "Other" ? m.exchangeOther : m.exchange;
    const stock = m.stock === "Other" ? m.stockOther : m.stock;

    if (exchange) fd.append("exchange", exchange);
    if (stock) fd.append("stock", stock);
    // date_format / time_format removed: backend auto-detects from DATETIME_FORMATS list.
    if (m.entry_type_static) fd.append("entry_type_static", m.entry_type_static);
    if (m.sl_type) fd.append("sl_type", m.sl_type);
    if (m.tp_type) fd.append("tp_type", m.tp_type);
    if (m.buyValue) fd.append("buy_value", m.buyValue);
    if (m.sellValue) fd.append("sell_value", m.sellValue);
    if (m.ceValue) fd.append("ce_value", m.ceValue);
    if (m.peValue) fd.append("pe_value", m.peValue);
    if (m.updatedBy) fd.append("updatedBy", m.updatedBy);

    try {
      const res = await fetch("http://127.0.0.1:8000/api/signals/ingest", { method: "POST", body: fd });
      const data = await res.json();
      setUploadStatus(data.error ? "Error: " + data.error : data.message);
      if (!data.error) {
        fetch("http://127.0.0.1:8000/api/signals/providers")
          .then(r => r.json())
          .then(d => { if (Array.isArray(d.providers)) setSignalProviderOptions(d.providers); });
      }
    } catch {
      setUploadStatus("Failed to contact backend. Ensure uvicorn is running.");
    }
  };

  // Fetch Preview Data
  const fetchPreview = async () => {
    if (!selectedFile) return;
    setPreviewLoading(true);
    const fd = new FormData();
    fd.append("file", selectedFile);
    fd.append("dataType", importType);
    let mappings: Record<string, string> = {};
    let stock = "", exchange = "", optionType = "", expiry = "", indicatorName = "", startDate = "", endDate = "", startTime = "", endTime = "";
    if (importType === "options") {
      const m = optionsMap;
      if (m.dateTime) mappings[m.dateTime] = "dateTime"; if (m.date) mappings[m.date] = "date"; if (m.time) mappings[m.time] = "time";
      if (m.open) mappings[m.open] = "open"; if (m.high) mappings[m.high] = "high"; if (m.low) mappings[m.low] = "low";
      if (m.close) mappings[m.close] = "close"; if (m.volume) mappings[m.volume] = "volume"; if (m.script) mappings[m.script] = "script";
      exchange = m.exchange === "Other" ? m.exchangeOther : m.exchange;
      stock = m.stock === "Other" ? m.stockOther : m.stock;
      optionType = m.type === "Other" ? m.typeOther : m.type;
      expiry = m.expiry; startDate = m.startDate; endDate = m.endDate; startTime = m.startTime; endTime = m.endTime;
    } else if (importType === "indicator") {
      const m = indicatorMap;
      if (m.dateTime) mappings[m.dateTime] = "dateTime"; if (m.date) mappings[m.date] = "date"; if (m.time) mappings[m.time] = "time";
      if (m.open) mappings[m.open] = "open"; if (m.high) mappings[m.high] = "high"; if (m.low) mappings[m.low] = "low";
      if (m.close) mappings[m.close] = "close"; if (m.volume) mappings[m.volume] = "volume";
      if (m.buy) mappings[m.buy] = "buySignal"; if (m.sell) mappings[m.sell] = "sellSignal";
      exchange = m.exchange === "Other" ? m.exchangeOther : m.exchange;
      stock = m.stock === "Other" ? m.stockOther : m.stock;
      indicatorName = m.indicator === "Other" ? m.indicatorOther : m.indicator;
      startDate = m.startDate; endDate = m.endDate; startTime = m.startTime; endTime = m.endTime;
    } else if (importType === "signal") {
      const m = signalMap;
      // Map all user-selected headers to their DB field names
      if (m.date) mappings[m.date] = "date";
      if (m.time) mappings[m.time] = "time";
      // Include exchange/stock column mappings if user selected them from file headers
      if (m.exchangeCol) mappings[m.exchangeCol] = "exchange";
      if (m.stockCol) mappings[m.stockCol] = "stock";
      if (m.script) mappings[m.script] = "script";
      if (m.type) mappings[m.type] = "type";
      if (m.expiry) mappings[m.expiry] = "expiry";
      if (m.trade_type) mappings[m.trade_type] = "trade_type";
      if (m.signal) mappings[m.signal] = "signal";
      if (m.entry_type_col) mappings[m.entry_type_col] = "entry_type";
      if (m.entry_price) mappings[m.entry_price] = "entry_price";
      if (m.sl) mappings[m.sl] = "sl";
      if (m.target_1) mappings[m.target_1] = "target_1";
      if (m.target_2) mappings[m.target_2] = "target_2";
      if (m.target_3) mappings[m.target_3] = "target_3";
      if (m.target_4) mappings[m.target_4] = "target_4";
      if (m.target_5) mappings[m.target_5] = "target_5";
      exchange = m.exchange === "Other" ? m.exchangeOther : m.exchange;
      stock = m.stock === "Other" ? m.stockOther : m.stock;
      startDate = m.startDate; endDate = m.endDate; startTime = m.startTime; endTime = m.endTime;
    }
    const clean = Object.fromEntries(Object.entries(mappings).filter(([k, v]) => k && v));
    fd.append("mappings", JSON.stringify(clean));
    if (exchange) fd.append("exchange", exchange);
    if (stock) fd.append("stock", stock);
    if (optionType) fd.append("optionType", optionType);
    if (expiry) fd.append("expiry", expiry);
    if (indicatorName) fd.append("indicatorName", indicatorName);
    if (startDate) fd.append("startDate", startDate);
    if (endDate) fd.append("endDate", endDate);
    if (startTime) fd.append("startTime", startTime);
    if (endTime) fd.append("endTime", endTime);
    const timeframePrev = importType === "indicator" ? indicatorMap.timeframe : null;
    if (timeframePrev) fd.append("timeframe", timeframePrev);
    if (importType === "indicator" && indicatorMap.updatedBy) fd.append("updatedBy", indicatorMap.updatedBy);
    if (importType === "options" && optionsMap.updatedBy) fd.append("updatedBy", optionsMap.updatedBy);


    try {
      const res = await fetch("http://127.0.0.1:8000/api/preview", { method: "POST", body: fd });
      const data = await res.json();
      if (!data.error) {
        setPreviewData(data.preview || []);
        if (data.unique_dates) setUniqueDates(data.unique_dates);
        if (data.unique_times) setUniqueTimes(data.unique_times);
        // FIX: Store file range in display-only state — do NOT write into filter state.
        // Filter state (startDate/endDate/startTime/endTime) stays empty = "All" by default.
        // Filters are only applied when the user explicitly selects a value in the dropdown.
        // This ensures ingestion imports ALL rows unless the user intentionally filters.
        setPreviewRange({
          minDate: data.min_date || "",
          maxDate: data.max_date || "",
          minTime: data.min_time || "",
          maxTime: data.max_time || "",
        });
      }
    } catch {
      // ignore
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (selectedFile) fetchPreview();
    }, 500);
    return () => clearTimeout(timer);
    // signalMap added so preview re-triggers when signal column mappings change
  }, [optionsMap, indicatorMap, spotMap, signalMap, importType, selectedFile, manualScript]);

  // FIX: real POST /api/validate + job polling — no more mock setTimeout
  const handleValidateSubmit = async () => {
    setValidatorStatus("Submitting validation job...");
    setReport(null);
    const payload = {
      stock: valConfig.stock,
      indicatorName: valConfig.indicator,
      offsetType: valConfig.script,
      offsetValue: valConfig.script === "ATM" ? 0 : parseInt(valConfig.atmOffset),
      entrySignal: valConfig.entrySignal, exitSignal: valConfig.exitSignal,
      entryTiming: valConfig.entryTime, exitTiming: valConfig.exitTime,
      applyOn: valConfig.applyOn,
      executionPrice: valConfig.executionPrice,
      tradeAmountType: valConfig.tradeAmountType,
      tradeAmountLots: parseFloat(valConfig.tradeAmountLots) || 0,
      repetitiveSignals: valConfig.repetitiveSignals,
      positionOpenEndDate: valConfig.endDate ? valConfig.endDate.replace("T", " ") + " 00:00:00" : null,
      positionOpenEndAction: valConfig.positionOpenEndAction,
      startDate: valConfig.startDate || null, endDate: valConfig.endDate || null,
      timeframe: valConfig.timeframe || "1m",
    };
    try {
      const res = await fetch("http://127.0.0.1:8000/api/validate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) { setValidatorStatus("Error: " + data.error); return; }
      setValidatorStatus("Job running… polling for results.");
      // Poll every 2s — background task prevents frontend timeout on large data
      const poll = setInterval(async () => {
        try {
          const s = await fetch(`http://127.0.0.1:8000/api/validate/status/${data.jobId}`);
          const sd = await s.json();
          if (sd.status === "done") {
            clearInterval(poll);
            setReport(sd.result);
            setActiveTab("results");
            setValidatorStatus("");
          } else if (sd.status === "error") {
            clearInterval(poll);
            setValidatorStatus("Error: " + JSON.stringify(sd.result?.error));
          }
        } catch { clearInterval(poll); }
      }, 2000);
    } catch { setValidatorStatus("Failed to contact backend. Ensure uvicorn is running."); }
  };

  // Fetch dynamic indicator list on mount and when tabs change
  useEffect(() => {
    fetch("http://127.0.0.1:8000/api/indicators")
      .then(r => r.json())
      .then(d => {
        if (Array.isArray(d.indicators)) {
          setIndicatorOptions(d.indicators);
          // Auto-select first indicator in validator if none selected
          if (activeTab === "validator" && d.indicators.length > 0 && !valConfig.indicator) {
            setValConfig(v => ({ ...v, indicator: d.indicators[0] }));
          }
        }
      })
      .catch(() => { });

    fetch("http://127.0.0.1:8000/api/signals/providers")
      .then(r => r.json())
      .then(d => {
        if (Array.isArray(d.providers)) {
          setSignalProviderOptions(d.providers);
        }
      })
      .catch(() => { });
  }, [activeTab]);

  // ---------------------------------------------------------------------------
  // Clear Table Data: fetch ingestion timestamps for the selected table
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (clearDb.open && clearDb.selected) {
      // Find if selected table has updated_on, expiry, or type
      const table = clearDb.tables.find(t => t.name === clearDb.selected);
      if (table && (table.hasUpdatedOn || table.hasExpiry || table.hasType)) {
        fetch(`http://127.0.0.1:8000/api/admin/tables/${clearDb.selected}/filters`)
          .then(r => r.json())
          .then(data => {
            setClearDb(prev => ({
              ...prev,
              timestamps: data.timestamps || [],
              expiries: data.expiries || [],
              types: data.types || [],
              selectedTimestamp: "", // Reset selection when table changes
              selectedExpiry: "",
              selectedType: ""
            }));
          })
          .catch(() => setClearDb(prev => ({
            ...prev, timestamps: [], expiries: [], types: []
          })));
      } else {
        setClearDb(prev => ({
          ...prev, timestamps: [], expiries: [], types: [],
          selectedTimestamp: "", selectedExpiry: "", selectedType: ""
        }));
      }
    }
  }, [clearDb.selected, clearDb.open]);

  // ---------------------------------------------------------------------------
  // Clear Table Data: fetch table list from backend dynamically
  // REUSABLE: Pattern for any admin-level destructive action with confirmation.
  // ---------------------------------------------------------------------------
  const fetchDbTables = async () => {
    try {
      const res = await fetch("http://127.0.0.1:8000/api/admin/tables");
      const data = await res.json();
      const tables = data.tables || [];
      setClearDb(prev => ({
        ...prev,
        open: true,
        tables,
        selected: tables.length > 0 ? tables[0].name : "",
        result: "",
        timestamps: [],
        selectedTimestamp: "",
        expiries: [],
        selectedExpiry: "",
        types: [],
        selectedType: "",
      }));
    } catch {
      setClearDb(prev => ({ ...prev, open: true, tables: [], result: "Failed to fetch table list from backend." }));
    }
  };

  const handleClearTable = async () => {
    if (!clearDb.selected) return;

    // Warning for full table deletion
    if (!clearDb.selectedTimestamp && !clearDb.selectedExpiry && !clearDb.selectedType) {
      const confirmed = window.confirm(`WARNING: No filters selected. This will delete ALL ${clearDb.tables.find(t => t.name === clearDb.selected)?.rowCount || ""} records from "${clearDb.selected}". Are you sure you want to proceed?`);
      if (!confirmed) return;
    }

    setClearDb(prev => ({ ...prev, loading: true, result: "" }));
    try {
      const params = new URLSearchParams();
      if (clearDb.selectedTimestamp) params.append("updated_on", clearDb.selectedTimestamp);
      if (clearDb.selectedExpiry) params.append("expiry", clearDb.selectedExpiry);
      if (clearDb.selectedType) params.append("type", clearDb.selectedType);

      const qs = params.toString();
      const url = `http://127.0.0.1:8000/api/admin/tables/${clearDb.selected}/clear${qs ? `?${qs}` : ""}`;
      const res = await fetch(url, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        // Refresh row counts after clear
        const refreshRes = await fetch("http://127.0.0.1:8000/api/admin/tables");
        const refreshData = await refreshRes.json();
        setClearDb(prev => ({
          ...prev,
          loading: false,
          tables: refreshData.tables || prev.tables,
          result: data.message,
          selectedTimestamp: "", // Reset after clear
          selectedExpiry: "",
          selectedType: "",
        }));
      } else {
        setClearDb(prev => ({ ...prev, loading: false, result: data.detail || "An error occurred." }));
      }
    } catch {
      setClearDb(prev => ({ ...prev, loading: false, result: "Failed to connect to backend." }));
    }
  };


  // UI Helper: header dropdown using the active form's own header list
  const renderHeaderDropdown = (val: string, setter: (val: string) => void, label: string, headers = activeHeaders, tooltip?: string) => (
    <div className="flex flex-col gap-1 w-full">
      <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </label>
      <select value={val} onChange={(e) => setter(e.target.value)}
        className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50">
        <option value="">Select Header</option>
        {headers.map(h => <option key={h} value={h}>{h}</option>)}
      </select>
    </div>
  );

  const renderTimeframeSelector = (val: string, setter: (val: string) => void, tooltip?: string) => (
    <div className="flex flex-col gap-1 w-full">
      <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
        Timeframe
        {tooltip && <InfoTooltip text={tooltip} />}
      </label>
      <select value={val} onChange={(e) => setter(e.target.value)}
        className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50">
        <option value="1m">1 Minute</option>
        <option value="5m">5 Minutes</option>
        <option value="15m">15 Minutes</option>
        <option value="30m">30 Minutes</option>
        <option value="1h">1 Hour</option>
        <option value="1d">1 Day</option>
      </select>
    </div>
  );

  return (
    <div className="bg-background text-on-background min-h-screen flex flex-col font-body">

      {/* ── Clear Table Data Warning Modal ─────────────────────────────────── */}
      {clearDb.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setClearDb(prev => ({ ...prev, open: false })); }}
        >
          <div className="bg-surface-container-lowest border border-red-500/30 rounded-2xl p-8 w-full max-w-md shadow-[0_0_40px_rgba(255,100,100,0.15)] animate-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center flex-shrink-0">
                <Trash2 size={18} className="text-red-400" />
              </div>
              <div>
                <h3 className="font-headline font-bold text-lg text-white">Clear Table Data</h3>
                <p className="text-xs text-red-400 font-semibold uppercase tracking-wider">Destructive Action — Cannot Be Undone</p>
              </div>
            </div>

            <p className="text-sm text-slate-400 mb-6 mt-3 leading-relaxed">
              All rows in the selected table will be permanently deleted.
              The table structure, columns, and indexes will be preserved.
            </p>

            {/* Table Selector */}
            <div className="flex flex-col gap-1 mb-4">
              <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Select Table to Clear</label>
              <select
                value={clearDb.selected}
                onChange={(e) => setClearDb(prev => ({ ...prev, selected: e.target.value }))}
                className="bg-surface-container-low border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500/50"
              >
                {clearDb.tables.map(t => (
                  <option key={t.name} value={t.name}>
                    {t.name} ({t.rowCount} rows)
                  </option>
                ))}
              </select>
            </div>

            {/* Filter Selectors Container */}
            <div className="flex flex-col gap-3 mb-4">
              {/* Updated On */}
              {clearDb.tables.find(t => t.name === clearDb.selected)?.hasUpdatedOn && (
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Filter by "Updated On" (Optional)</label>
                  <select
                    value={clearDb.selectedTimestamp}
                    onChange={(e) => setClearDb(prev => ({ ...prev, selectedTimestamp: e.target.value }))}
                    className="bg-surface-container-low border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500/50"
                  >
                    <option value="">Show All</option>
                    {clearDb.timestamps.map(ts => (
                      <option key={ts} value={ts}>{ts.replace("T", " ")}</option>
                    ))}
                  </select>
                  {clearDb.timestamps.length === 0 && (
                    <p className="text-[10px] text-slate-500 mt-1 italic">Note: Records ingested before the update don't have a timestamp. Ingest new data to see filters here.</p>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                {/* Expiry Time */}
                {clearDb.tables.find(t => t.name === clearDb.selected)?.hasExpiry && (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Filter by "Expiry Time" (Optional)</label>
                    <select
                      value={clearDb.selectedExpiry}
                      onChange={(e) => setClearDb(prev => ({ ...prev, selectedExpiry: e.target.value }))}
                      className="bg-surface-container-low border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500/50"
                    >
                      <option value="">Show All</option>
                      {clearDb.expiries.map(exp => (
                        <option key={exp} value={exp}>{exp}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Type */}
                {clearDb.tables.find(t => t.name === clearDb.selected)?.hasType && (
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Filter by "Type" (Optional)</label>
                    <select
                      value={clearDb.selectedType}
                      onChange={(e) => setClearDb(prev => ({ ...prev, selectedType: e.target.value }))}
                      className="bg-surface-container-low border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500/50"
                    >
                      <option value="">Show All</option>
                      {clearDb.types.map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>

            {/* Row count warning */}
            {clearDb.selected && (() => {
              const tbl = clearDb.tables.find(t => t.name === clearDb.selected);
              const isFiltered = !!(clearDb.selectedTimestamp || clearDb.selectedExpiry || clearDb.selectedType);

              if (!tbl) return null;

              return (
                <div className={`border rounded-lg px-4 py-3 mb-5 ${isFiltered ? "bg-primary/5 border-primary/20" : "bg-red-500/5 border-red-500/20"}`}>
                  <p className="text-sm">
                    {isFiltered ? (
                      <span className="text-primary/80">
                        ⚠ Deleting only matching records
                      </span>
                    ) : (
                      <span className="text-red-300">
                        ⚠ <span className="font-bold text-red-400">WARNING:</span> This will delete <span className="font-bold text-red-400">ALL {tbl.rowCount} rows</span> from <span className="font-bold text-white">{tbl.name}</span>
                      </span>
                    )}
                  </p>
                </div>
              );
            })()}

            {/* Result message */}
            {clearDb.result && (
              <div className={`rounded-lg px-4 py-3 mb-4 text-sm ${clearDb.result.startsWith("Cleared") || clearDb.result.startsWith("✓")
                ? "bg-primary/10 border border-primary/30 text-primary"
                : "bg-red-500/10 border border-red-500/30 text-red-300"
                }`}>
                {clearDb.result}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setClearDb(prev => ({ ...prev, open: false, result: "" }))}
                className="px-5 py-2 text-sm font-semibold rounded-lg border border-white/10 text-slate-400 hover:text-white hover:border-white/30 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleClearTable}
                disabled={clearDb.loading || !clearDb.selected}
                className="px-5 py-2 text-sm font-bold rounded-lg bg-red-500/10 border border-red-500/40 text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {clearDb.loading ? (
                  <><span className="inline-block w-3 h-3 border-2 border-red-400/30 border-t-red-400 rounded-full animate-spin" /> Clearing...</>
                ) : (
                  <><Trash2 size={13} /> Clear Table</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}

      <header className="border-b border-white/5 bg-surface-container-lowest py-4 px-6 flex items-center justify-between sticky top-0 z-10 shadow-lg">
        <div className="flex items-center gap-3">
          <Database className="text-primary" size={20} />
          <span className="font-headline font-bold text-lg tracking-tight uppercase">Terminal <span className="text-primary">Dashboard</span></span>
        </div>
        <div className="flex gap-4 items-center">
          <button onClick={() => setActiveTab("ingestion")} className={`px-4 py-2 text-sm font-semibold rounded transition-all ${activeTab === 'ingestion' ? 'bg-primary/10 text-primary border border-primary/20 shadow-[0_0_15px_rgba(78,222,163,0.15)]' : 'text-slate-400 hover:text-white'}`}>
            <Upload size={16} className="inline mr-2" /> Data Import
          </button>
          <button onClick={() => setActiveTab("validator")} className={`px-4 py-2 text-sm font-semibold rounded transition-all ${activeTab === 'validator' ? 'bg-primary/10 text-primary border border-primary/20 shadow-[0_0_15px_rgba(78,222,163,0.15)]' : 'text-slate-400 hover:text-white'}`}>
            <Settings size={16} className="inline mr-2" /> Indicator Validator
          </button>
          <button onClick={() => setActiveTab("results")} className={`px-4 py-2 text-sm font-semibold rounded transition-all ${activeTab === 'results' ? 'bg-primary/10 text-primary border border-primary/20 shadow-[0_0_15px_rgba(78,222,163,0.15)]' : 'text-slate-400 hover:text-white'}`}>
            <BarChart2 size={16} className="inline mr-2" /> Results
          </button>

          {/* Separator */}
          <div className="w-px h-6 bg-white/10" />

          {/* Clear Table Data button — opens warning modal with dynamic table list */}
          <button
            id="btn-clear-table-data"
            onClick={fetchDbTables}
            className="px-4 py-2 text-sm font-semibold rounded transition-all flex items-center gap-2 text-red-400/70 border border-red-500/20 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/40 hover:shadow-[0_0_12px_rgba(239,68,68,0.15)]"
            title="Clear data from a database table"
          >
            <Trash2 size={14} /> Clear Data
          </button>
        </div>
      </header>


      {/* Main Content */}
      <main className="flex-grow p-8 max-w-6xl mx-auto w-full">

        {/* TAB: Ingestion */}
        {activeTab === "ingestion" && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <h2 className="text-3xl font-headline font-black mb-6 flex items-center gap-3">
              <Database className="text-primary" size={28} /> Data Import Mapping
            </h2>

            <div className="glass-card border border-white/5 p-8 rounded-xl space-y-8 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-50"></div>

              {/* Type Selection: 3 types as required */}
              <div className="mb-8">
                <label className="block text-sm font-bold mb-3 text-slate-300">Select Import Type</label>
                <div className="flex bg-surface-container-low p-1 rounded-lg border border-white/10 w-full md:w-3/4">
                  <button onClick={() => setImportType("options")}
                    className={`flex-1 py-2 px-3 text-sm font-bold rounded-md transition-all ${importType === "options" ? "bg-primary text-on-primary shadow-lg" : "text-slate-400 hover:text-white"}`}>
                    Options/Equity
                  </button>
                  <button onClick={() => setImportType("indicator")}
                    className={`flex-1 py-2 px-3 text-sm font-bold rounded-md transition-all ${importType === "indicator" ? "bg-primary text-on-primary shadow-lg" : "text-slate-400 hover:text-white"}`}>
                    Indicator Data
                  </button>
                  <button onClick={() => setImportType("signal")}
                    className={`flex-1 py-2 px-3 text-sm font-bold rounded-md transition-all ${importType === "signal" ? "bg-primary text-on-primary shadow-lg" : "text-slate-400 hover:text-white"}`}>
                    Signal Data
                  </button>
                </div>
              </div>

              {isUploading && <div className="text-sm text-primary animate-pulse flex items-center gap-2"><Upload size={14} className="animate-bounce" /> Extracting headers from file...</div>}

              {/* Mapping Forms */}
              {!isUploading && (
                <form onSubmit={handleIngestSubmit} className="space-y-8 pt-8 border-t border-white/10 animate-in fade-in zoom-in-95 duration-500">

                  <div className="mb-6 p-4 bg-surface-container-low border border-primary/20 rounded-lg text-sm text-slate-300">
                    <h4 className="font-bold text-primary mb-2 flex items-center gap-2"><Info size={16} /> How to use the Data Import tool</h4>
                    <ul className="list-disc list-inside space-y-1">
                      <li>Select the type of data you are importing (Options or Indicator).</li>
                      <li>Choose a CSV or Excel file to automatically extract column headers.</li>
                      <li>Map your file's columns to the database fields using the dropdowns.</li>
                      <li><strong className="text-primary/80">Phase 1 Upgrade:</strong> Options Data now auto-extracts Strike and Lot Size. Spot data is no longer required.</li>
                    </ul>
                  </div>

                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-1 bg-primary rounded-full"></div>
                      <h3 className="text-xl font-bold font-headline">
                        {importType === 'options' ? 'Options/Equity' : importType === 'indicator' ? 'Indicator' : importType === 'signal' ? 'Signal' : 'Spot/Index'} Data — Header Mapping
                      </h3>
                    </div>
                    <div className="bg-surface-container-low p-3 rounded-lg border border-white/10 flex flex-col justify-center border-dashed hover:border-primary/50 transition-colors w-full md:w-auto min-w-[240px]">
                      {!selectedFile ? (
                        <>
                          <label className="block text-xs font-bold mb-2 text-slate-300 cursor-pointer flex items-center gap-2">
                            <FileText size={14} className="text-primary" /> Select {importType === 'options' ? 'Options/Equity' : importType === 'indicator' ? 'Indicator' : importType === 'signal' ? 'Signal' : 'Spot/Index'} File
                          </label>
                          <input type="file" onChange={handleFileChange} className="text-sm text-slate-400 file:mr-4 file:py-1.5 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-primary/10 file:text-primary hover:file:bg-primary/20 cursor-pointer w-full" />
                        </>
                      ) : (
                        <div className="flex items-center justify-between gap-4 py-1">
                          <div className="flex items-center gap-2 overflow-hidden">
                            <div className="bg-primary/10 p-1.5 rounded-lg">
                              <FileText size={16} className="text-primary" />
                            </div>
                            <div className="flex flex-col min-w-0">
                              <span className="text-xs font-bold text-white truncate max-w-[180px]" title={selectedFile.name}>
                                {selectedFile.name}
                              </span>
                              <span className="text-[10px] text-slate-400 font-medium">Ready to map</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={handleRemoveFile}
                            className="p-1.5 rounded-full bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-all flex-shrink-0"
                            title="Remove file"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {importType === "indicator" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-surface-container-low/50 p-6 rounded-lg border border-white/5">
                      <div className="flex flex-col gap-1 w-full">
                        <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
                          Indicator Name <span className="text-red-400 ml-1">*</span>
                          <InfoTooltip text="The exact name of the indicator (e.g. RSI, MACD). This identifies the signal source in the validator." />
                        </label>
                        <select
                          value={indicatorMap.indicator}
                          onChange={(e) => setIndicatorMap({ ...indicatorMap, indicator: e.target.value })}
                          className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                        >
                          <option value="">Select Indicator</option>
                          {indicatorOptions.map(name => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                          <option value="Other">Other (custom)</option>
                        </select>
                      </div>
                      {indicatorMap.indicator === "Other" && (
                        <div className="flex flex-col gap-1 w-full animate-in slide-in-from-right-4">
                          <label className="text-primary font-bold uppercase tracking-wider text-[10px]">Custom Indicator Name</label>
                          <input type="text" value={indicatorMap.indicatorOther} onChange={(e) => setIndicatorMap({ ...indicatorMap, indicatorOther: e.target.value })} className="bg-surface-container-lowest border border-primary/30 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary" placeholder="Enter indicator name" />
                        </div>
                      )}
                      {renderTimeframeSelector(indicatorMap.timeframe, (v) => setIndicatorMap({ ...indicatorMap, timeframe: v }))}
                    </div>
                  )}



                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6 bg-surface-container-lowest p-6 rounded-lg border border-white/5">
                    {/* Signal files always have separate Date + Time columns; backend merges them. No combined DateTime mapping. */}
                    {importType === "options" && renderHeaderDropdown(optionsMap.dateTime, v => setOptionsMap({ ...optionsMap, dateTime: v }), "DateTime", activeHeaders, "Combined Date & Time column. Leave blank if your file splits Date and Time.")}
                    {importType === "indicator" && renderHeaderDropdown(indicatorMap.dateTime, v => setIndicatorMap({ ...indicatorMap, dateTime: v }), "DateTime", activeHeaders, "Combined Date & Time column. Leave blank if your file splits Date and Time.")}
                    {importType === "spot" && renderHeaderDropdown(spotMap.dateTime, v => setSpotMap({ ...spotMap, dateTime: v }), "DateTime", activeHeaders, "Combined Date & Time column. Leave blank if your file splits Date and Time.")}
                    {/* Signal: show a placeholder div so grid layout stays consistent */}
                    {importType === "signal" && <div />}


                    <div className="col-span-1 md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* Date Config */}
                      <div className="space-y-3 p-4 bg-surface-container border border-white/5 rounded-md">
                        <div className="flex justify-between items-center">
                          <span className="text-xs font-bold text-primary flex items-center">Date Filter <InfoTooltip text="Only import rows falling within this exact date range." /></span>
                          <span className="text-[10px] text-slate-400">
                            File Range: {previewRange.minDate || 'All'} to {previewRange.maxDate || 'All'}
                          </span>
                        </div>
                        {importType === "options" && renderHeaderDropdown(optionsMap.date, v => setOptionsMap({ ...optionsMap, date: v }), "Date Column", activeHeaders, "Map this if your file has a standalone Date column.")}
                        {importType === "indicator" && renderHeaderDropdown(indicatorMap.date, v => setIndicatorMap({ ...indicatorMap, date: v }), "Date Column", activeHeaders, "Map this if your file has a standalone Date column.")}
                        {importType === "signal" && renderHeaderDropdown(signalMap.date, v => setSignalMap({ ...signalMap, date: v }), "Date Column", activeHeaders, "Map this if your file has a standalone Date column.")}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="min-w-0">
                            <label className="text-[10px] text-slate-500 font-bold uppercase">Start Date</label>
                            {uniqueDates.length > 0 ? (
                              <select
                                value={importType === "options" ? optionsMap.startDate : importType === "signal" ? signalMap.startDate : indicatorMap.startDate}
                                onChange={e => importType === "options" ? setOptionsMap({ ...optionsMap, startDate: e.target.value }) : importType === "signal" ? setSignalMap({ ...signalMap, startDate: e.target.value }) : setIndicatorMap({ ...indicatorMap, startDate: e.target.value })}
                                className="w-full bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-sm text-white focus:border-primary/50"
                              >
                                <option value="">All Dates</option>
                                {uniqueDates.map(d => <option key={d} value={d}>{d}</option>)}
                              </select>
                            ) : (
                              <input type="date"
                                value={importType === "options" ? optionsMap.startDate : importType === "signal" ? signalMap.startDate : indicatorMap.startDate}
                                onChange={e => importType === "options" ? setOptionsMap({ ...optionsMap, startDate: e.target.value }) : importType === "signal" ? setSignalMap({ ...signalMap, startDate: e.target.value }) : setIndicatorMap({ ...indicatorMap, startDate: e.target.value })}
                                className="w-full bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-sm text-white focus:border-primary/50 [color-scheme:dark]" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <label className="text-[10px] text-slate-500 font-bold uppercase">End Date</label>
                            {uniqueDates.length > 0 ? (
                              <select
                                value={importType === "options" ? optionsMap.endDate : importType === "signal" ? signalMap.endDate : indicatorMap.endDate}
                                onChange={e => importType === "options" ? setOptionsMap({ ...optionsMap, endDate: e.target.value }) : importType === "signal" ? setSignalMap({ ...signalMap, endDate: e.target.value }) : setIndicatorMap({ ...indicatorMap, endDate: e.target.value })}
                                className="w-full bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-sm text-white focus:border-primary/50"
                              >
                                <option value="">All Dates</option>
                                {uniqueDates.map(d => <option key={d} value={d}>{d}</option>)}
                              </select>
                            ) : (
                              <input type="date"
                                value={importType === "options" ? optionsMap.endDate : importType === "signal" ? signalMap.endDate : indicatorMap.endDate}
                                onChange={e => importType === "options" ? setOptionsMap({ ...optionsMap, endDate: e.target.value }) : importType === "signal" ? setSignalMap({ ...signalMap, endDate: e.target.value }) : setIndicatorMap({ ...indicatorMap, endDate: e.target.value })}
                                className="w-full bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-sm text-white focus:border-primary/50 [color-scheme:dark]" />
                            )}
                          </div>
                        </div>
                      </div>
                      {/* Time Config */}
                      <div className="space-y-3 p-4 bg-surface-container border border-white/5 rounded-md">
                        <div className="flex justify-between items-center">
                          <span className="text-xs font-bold text-primary flex items-center">Time Filter <InfoTooltip text="Only import rows falling within this exact time window each day." /></span>
                          <span className="text-[10px] text-slate-400">
                            File Range: {previewRange.minTime || 'All'} to {previewRange.maxTime || 'All'}
                          </span>
                        </div>
                        {importType === "options" && renderHeaderDropdown(optionsMap.time, v => setOptionsMap({ ...optionsMap, time: v }), "Time Column", activeHeaders, "Map this if your file has a standalone Time column.")}
                        {importType === "indicator" && renderHeaderDropdown(indicatorMap.time, v => setIndicatorMap({ ...indicatorMap, time: v }), "Time Column", activeHeaders, "Map this if your file has a standalone Time column.")}
                        {importType === "signal" && renderHeaderDropdown(signalMap.time, v => setSignalMap({ ...signalMap, time: v }), "Time Column", activeHeaders, "Map this if your file has a standalone Time column.")}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="min-w-0">
                            <label className="text-[10px] text-slate-500 font-bold uppercase">Start Time</label>
                            {uniqueTimes.length > 0 ? (
                              <select
                                value={importType === "options" ? optionsMap.startTime : importType === "signal" ? signalMap.startTime : indicatorMap.startTime}
                                onChange={e => importType === "options" ? setOptionsMap({ ...optionsMap, startTime: e.target.value }) : importType === "signal" ? setSignalMap({ ...signalMap, startTime: e.target.value }) : setIndicatorMap({ ...indicatorMap, startTime: e.target.value })}
                                className="w-full bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-sm text-white focus:border-primary/50"
                              >
                                <option value="">All Times</option>
                                {uniqueTimes.map(t => <option key={t} value={t}>{t}</option>)}
                              </select>
                            ) : (
                              <input type="time" step="1"
                                value={importType === "options" ? optionsMap.startTime : importType === "signal" ? signalMap.startTime : indicatorMap.startTime}
                                onChange={e => importType === "options" ? setOptionsMap({ ...optionsMap, startTime: e.target.value }) : importType === "signal" ? setSignalMap({ ...signalMap, startTime: e.target.value }) : setIndicatorMap({ ...indicatorMap, startTime: e.target.value })}
                                className="w-full bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-sm text-white focus:border-primary/50 [color-scheme:dark]" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <label className="text-[10px] text-slate-500 font-bold uppercase">End Time</label>
                            {uniqueTimes.length > 0 ? (
                              <select
                                value={importType === "options" ? optionsMap.endTime : importType === "signal" ? signalMap.endTime : indicatorMap.endTime}
                                onChange={e => importType === "options" ? setOptionsMap({ ...optionsMap, endTime: e.target.value }) : importType === "signal" ? setSignalMap({ ...signalMap, endTime: e.target.value }) : setIndicatorMap({ ...indicatorMap, endTime: e.target.value })}
                                className="w-full bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-sm text-white focus:border-primary/50"
                              >
                                <option value="">All Times</option>
                                {uniqueTimes.map(t => <option key={t} value={t}>{t}</option>)}
                              </select>
                            ) : (
                              <input type="time" step="1"
                                value={importType === "options" ? optionsMap.endTime : importType === "signal" ? signalMap.endTime : indicatorMap.endTime}
                                onChange={e => importType === "options" ? setOptionsMap({ ...optionsMap, endTime: e.target.value }) : importType === "signal" ? setSignalMap({ ...signalMap, endTime: e.target.value }) : setIndicatorMap({ ...indicatorMap, endTime: e.target.value })}
                                className="w-full bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-sm text-white focus:border-primary/50 [color-scheme:dark]" />
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* OHLCV Map — options/indicator */}
                  {importType !== "signal" && (
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                      {renderHeaderDropdown(importType === "options" ? optionsMap.open : indicatorMap.open, v => importType === "options" ? setOptionsMap({ ...optionsMap, open: v }) : setIndicatorMap({ ...indicatorMap, open: v }), "Open", activeHeaders, "Opening price of the candle")}
                      {renderHeaderDropdown(importType === "options" ? optionsMap.high : indicatorMap.high, v => importType === "options" ? setOptionsMap({ ...optionsMap, high: v }) : setIndicatorMap({ ...indicatorMap, high: v }), "High", activeHeaders, "Highest price of the candle")}
                      {renderHeaderDropdown(importType === "options" ? optionsMap.low : indicatorMap.low, v => importType === "options" ? setOptionsMap({ ...optionsMap, low: v }) : setIndicatorMap({ ...indicatorMap, low: v }), "Low", activeHeaders, "Lowest price of the candle")}
                      {renderHeaderDropdown(importType === "options" ? optionsMap.close : indicatorMap.close, v => importType === "options" ? setOptionsMap({ ...optionsMap, close: v }) : setIndicatorMap({ ...indicatorMap, close: v }), "Close", activeHeaders, "Closing price of the candle")}
                      {renderHeaderDropdown(importType === "options" ? optionsMap.volume : indicatorMap.volume, v => importType === "options" ? setOptionsMap({ ...optionsMap, volume: v }) : setIndicatorMap({ ...indicatorMap, volume: v }), "Volume", activeHeaders, "Trading volume (optional)")}
                    </div>
                  )}

                  {/* Base Setup Map */}
                  {importType !== "signal" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-white/5">

                      <div className="flex flex-col gap-1 w-full">
                        <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Exchange</label>
                        <select
                          value={importType === "options" ? optionsMap.exchange : indicatorMap.exchange}
                          onChange={(e) => importType === "options" ? setOptionsMap({ ...optionsMap, exchange: e.target.value }) : setIndicatorMap({ ...indicatorMap, exchange: e.target.value })}
                          className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                        >
                          <option value="NSE">NSE</option>
                          <option value="BSE">BSE</option>
                          <option value="Other">Other</option>
                        </select>
                        {((importType === "options" && optionsMap.exchange === "Other") || (importType === "indicator" && indicatorMap.exchange === "Other")) && (
                          <div className="mt-2 animate-in slide-in-from-top-2">
                            <input type="text" className="w-full bg-surface-container-lowest border border-primary/30 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary" placeholder="Enter custom exchange" />
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col gap-1 w-full">
                        <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Stock</label>
                        <select
                          value={importType === "options" ? optionsMap.stock : indicatorMap.stock}
                          onChange={(e) => importType === "options" ? setOptionsMap({ ...optionsMap, stock: e.target.value }) : setIndicatorMap({ ...indicatorMap, stock: e.target.value })}
                          className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                        >
                          <option value="NIFTY">NIFTY</option>
                          <option value="Sensex">Sensex</option>
                          <option value="Other">Other</option>
                        </select>
                        {((importType === "options" && optionsMap.stock === "Other") || (importType === "indicator" && indicatorMap.stock === "Other")) && (
                          <div className="mt-2 animate-in slide-in-from-top-2">
                            <input type="text" className="w-full bg-surface-container-lowest border border-primary/30 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary" placeholder="Enter custom stock" />
                          </div>
                        )}
                      </div>

                      {importType === "options" && (
                        <div className="col-span-1 md:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-6">
                          {renderHeaderDropdown(optionsMap.script, v => setOptionsMap({ ...optionsMap, script: v }), "Script Column", activeHeaders, "Map this to the 'Script' column in your file (e.g. 24750).")}

                          <div className="flex flex-col gap-1 w-full">
                            <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Type</label>
                            <select
                              value={optionsMap.type}
                              onChange={(e) => setOptionsMap({ ...optionsMap, type: e.target.value })}
                              className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                            >
                              <option value="Call">Call</option>
                              <option value="Put">Put</option>
                              <option value="Other">Other</option>
                            </select>
                            {optionsMap.type === "Other" && (
                              <div className="flex flex-col gap-1 w-full animate-in slide-in-from-right-4">
                                <label className="text-xs text-primary font-bold uppercase tracking-wider">Custom Type</label>
                                <input type="text" value={optionsMap.typeOther} onChange={(e) => setOptionsMap({ ...optionsMap, typeOther: e.target.value })} className="bg-surface-container-lowest border border-primary/30 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary" placeholder="Type" />
                              </div>
                            )}
                          </div>

                          <div className="flex flex-col gap-1 w-full">
                            <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Expiry</label>
                            <input type="date" value={optionsMap.expiry} onChange={(e) => setOptionsMap({ ...optionsMap, expiry: e.target.value })} className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50 [color-scheme:dark]" />
                          </div>
                        </div>
                      )}

                      {(importType === "indicator" || importType === "options") && (
                        <div className="flex flex-col gap-1 w-full md:col-span-2 mt-2">
                          <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Updated By</label>
                          <input
                            type="text"
                            value={importType === "options" ? optionsMap.updatedBy : indicatorMap.updatedBy}
                            onChange={(e) => importType === "options"
                              ? setOptionsMap({ ...optionsMap, updatedBy: e.target.value })
                              : setIndicatorMap({ ...indicatorMap, updatedBy: e.target.value })
                            }
                            className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                            placeholder="Enter your username (e.g. admin)"
                          />
                        </div>
                      )}


                    </div>
                  )}

                  {/* Indicator Specific Maps */}
                  {importType === "indicator" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-white/5">
                      {renderHeaderDropdown(indicatorMap.buy, (val) => setIndicatorMap({ ...indicatorMap, buy: val }), "Buy Signal Column")}
                      {renderHeaderDropdown(indicatorMap.sell, (val) => setIndicatorMap({ ...indicatorMap, sell: val }), "Sell Signal Column")}
                    </div>
                  )}
                  {/* Signal Specific Maps */}
                  {importType === "signal" && (
                    <div className="space-y-6">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-white/5">
                        <div className="flex flex-col gap-1 w-full">
                          <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
                            Signal Source Name <span className="text-red-400 ml-1">*</span>
                            <InfoTooltip text="The exact name of the signal source (e.g. Telegram Channel Name)." />
                          </label>
                          <select
                            value={signalMap.signal_provider}
                            onChange={(e) => setSignalMap({ ...signalMap, signal_provider: e.target.value })}
                            className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                          >
                            <option value="">Select Signal Provider</option>
                            {signalProviderOptions.map(name => (
                              <option key={name} value={name}>{name}</option>
                            ))}
                            <option value="Other">Other (custom)</option>
                          </select>
                        </div>
                        {signalMap.signal_provider === "Other" && (
                          <div className="flex flex-col gap-1 w-full animate-in slide-in-from-right-4">
                            <label className="text-primary font-bold uppercase tracking-wider text-[10px]">Custom Signal Source</label>
                            <input type="text" value={signalMap.signal_providerOther} onChange={(e) => setSignalMap({ ...signalMap, signal_providerOther: e.target.value })} className="bg-surface-container-lowest border border-primary/30 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary" placeholder="Enter signal source name" />
                          </div>
                        )}

                        {/* Date Format and Time Format fields removed per spec:
                            The backend auto-detects formats from the shared DATETIME_FORMATS list.
                            Users only need to map the Date column and Time column headers. */}
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 pt-4 border-t border-white/5">
                        <div className="flex flex-col gap-1 w-full">
                          <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
                            Exchange <InfoTooltip text="Select the exchange to filter imported rows. Only rows matching this exchange will be stored. If the file has no Exchange column, this value is used for all rows." />
                          </label>
                          <select value={signalMap.exchange} onChange={(e) => setSignalMap({ ...signalMap, exchange: e.target.value })} className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50">
                            <option value="">All (no filter)</option>
                            <option value="NSE">NSE</option>
                            <option value="BSE">BSE</option>
                            <option value="Other">Other</option>
                          </select>
                          {signalMap.exchange === "Other" && <input type="text" value={signalMap.exchangeOther} onChange={(e) => setSignalMap({ ...signalMap, exchangeOther: e.target.value })} className="mt-2 bg-surface-container-lowest border border-primary/30 rounded px-3 py-2 text-sm text-white" placeholder="Custom exchange" />}
                          {/* Exchange Column mapping — maps file header to the exchange DB field */}
                          {renderHeaderDropdown(signalMap.exchangeCol, v => setSignalMap({ ...signalMap, exchangeCol: v }), "Exchange Column", activeHeaders, "Map the Exchange column from your file. Values are stored as-is from the file; the dropdown above acts as a row filter.")}
                        </div>
                        <div className="flex flex-col gap-1 w-full">
                          <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
                            Stock <InfoTooltip text="Select the stock to filter imported rows. Only rows matching this stock will be stored. If the file has no Stock column, this value is used for all rows." />
                          </label>
                          <select value={signalMap.stock} onChange={(e) => setSignalMap({ ...signalMap, stock: e.target.value })} className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50">
                            <option value="">All (no filter)</option>
                            <option value="NIFTY">NIFTY</option>
                            <option value="BANKNIFTY">BANKNIFTY</option>
                            <option value="SENSEX">SENSEX</option>
                            <option value="Other">Other</option>
                          </select>
                          {signalMap.stock === "Other" && <input type="text" value={signalMap.stockOther} onChange={(e) => setSignalMap({ ...signalMap, stockOther: e.target.value })} className="mt-2 bg-surface-container-lowest border border-primary/30 rounded px-3 py-2 text-sm text-white" placeholder="Custom stock" />}
                          {/* Stock Column mapping — maps file header to the stock DB field */}
                          {renderHeaderDropdown(signalMap.stockCol, v => setSignalMap({ ...signalMap, stockCol: v }), "Stock Column", activeHeaders, "Map the Stock column from your file. Values are stored as-is from the file; the dropdown above acts as a row filter.")}
                        </div>
                        {renderHeaderDropdown(signalMap.script, v => setSignalMap({ ...signalMap, script: v }), "Script Column", activeHeaders, "Strike Price e.g. 24750")}
                        <div className="flex flex-col gap-1 w-full">
                          {renderHeaderDropdown(signalMap.expiry, v => setSignalMap({ ...signalMap, expiry: v }), "Expiry Column", activeHeaders, "Defaults to nearest Tue(NSE)/Thu(BSE) if empty")}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                        <div className="flex flex-col gap-1 w-full">
                          {renderHeaderDropdown(signalMap.type, v => setSignalMap({ ...signalMap, type: v }), "Type Column (CE/PE)", activeHeaders)}
                        </div>
                        {renderHeaderDropdown(signalMap.trade_type, v => setSignalMap({ ...signalMap, trade_type: v }), "Trade Type Column", activeHeaders, "e.g. Intraday, BTST. Defaults to Intraday if blank.")}
                        <div className="flex flex-col gap-1 w-full">
                          {renderHeaderDropdown(signalMap.signal, v => setSignalMap({ ...signalMap, signal: v }), "Signal Column", activeHeaders, "e.g. Buy/Sell")}
                        </div>
                        <div className="flex flex-col gap-1 w-full">
                          {renderHeaderDropdown(signalMap.entry_type_col, v => setSignalMap({ ...signalMap, entry_type_col: v }), "Entry Type Column", activeHeaders)}
                          <select value={signalMap.entry_type_static} onChange={(e) => setSignalMap({ ...signalMap, entry_type_static: e.target.value })} className="mt-2 bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-[10px] text-white">
                            <option value="Buy At">Default: Buy At</option>
                            <option value="Above">Default: Above</option>
                            <option value="Below">Default: Below</option>
                            <option value="Sell At">Default: Sell At</option>
                          </select>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 pt-4 border-t border-white/5">
                        {renderHeaderDropdown(signalMap.entry_price, v => setSignalMap({ ...signalMap, entry_price: v }), "Entry Price Column", activeHeaders)}
                        <div className="flex flex-col gap-1 w-full">
                          {renderHeaderDropdown(signalMap.sl, v => setSignalMap({ ...signalMap, sl: v }), "Stop Loss Column", activeHeaders)}
                          <select value={signalMap.sl_type} onChange={(e) => setSignalMap({ ...signalMap, sl_type: e.target.value })} className="mt-2 bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-[10px] text-white">
                            <option value="Points">Value Type: Points</option>
                            <option value="Percentage">Value Type: Percentage</option>
                          </select>
                        </div>
                        <div className="flex flex-col gap-1 w-full">
                          {renderHeaderDropdown(signalMap.target_1, v => setSignalMap({ ...signalMap, target_1: v }), "Target 1 Column", activeHeaders)}
                          <select value={signalMap.tp_type} onChange={(e) => setSignalMap({ ...signalMap, tp_type: e.target.value })} className="mt-2 bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-[10px] text-white">
                            <option value="Points">Value Type: Points</option>
                            <option value="Percentage">Value Type: Percentage</option>
                          </select>
                        </div>
                        {renderHeaderDropdown(signalMap.target_2, v => setSignalMap({ ...signalMap, target_2: v }), "Target 2 Column", activeHeaders)}
                      </div>

                      <div className="pt-2">
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                          {signalMap.extraTargetCount >= 1 && renderHeaderDropdown(signalMap.target_3, v => setSignalMap({ ...signalMap, target_3: v }), "Target 3 Column", activeHeaders)}
                          {signalMap.extraTargetCount >= 2 && renderHeaderDropdown(signalMap.target_4, v => setSignalMap({ ...signalMap, target_4: v }), "Target 4 Column", activeHeaders)}
                          {signalMap.extraTargetCount >= 3 && renderHeaderDropdown(signalMap.target_5, v => setSignalMap({ ...signalMap, target_5: v }), "Target 5 Column", activeHeaders)}
                          {signalMap.extraTargetCount >= 4 && renderHeaderDropdown(signalMap.target_6, v => setSignalMap({ ...signalMap, target_6: v }), "Target 6 Column", activeHeaders)}
                          {signalMap.extraTargetCount >= 5 && renderHeaderDropdown(signalMap.target_7, v => setSignalMap({ ...signalMap, target_7: v }), "Target 7 Column", activeHeaders)}
                          {signalMap.extraTargetCount >= 6 && renderHeaderDropdown(signalMap.target_8, v => setSignalMap({ ...signalMap, target_8: v }), "Target 8 Column", activeHeaders)}
                          {signalMap.extraTargetCount >= 7 && renderHeaderDropdown(signalMap.target_9, v => setSignalMap({ ...signalMap, target_9: v }), "Target 9 Column", activeHeaders)}
                          {signalMap.extraTargetCount >= 8 && renderHeaderDropdown(signalMap.target_10, v => setSignalMap({ ...signalMap, target_10: v }), "Target 10 Column", activeHeaders)}
                        </div>
                        {signalMap.extraTargetCount < 8 && (
                          <button type="button" onClick={() => setSignalMap({ ...signalMap, extraTargetCount: signalMap.extraTargetCount + 1 })} className="mt-4 text-xs font-bold text-primary hover:text-primary/80 flex items-center gap-1 border border-primary/20 rounded px-3 py-1.5 hover:bg-primary/5 transition-all">
                            + Add More Target
                          </button>
                        )}
                      </div>

                      <div className="flex flex-col gap-1 w-full md:w-1/2 mt-2">
                        <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Updated By</label>
                        <input
                          type="text"
                          value={signalMap.updatedBy}
                          onChange={(e) => setSignalMap({ ...signalMap, updatedBy: e.target.value })}
                          className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                          placeholder="Enter your username (e.g. admin)"
                        />
                      </div>
                    </div>
                  )}

                  <div className="pt-6 border-t border-white/10 flex justify-between items-center">
                    <button type="submit" className="w-full md:w-auto bg-primary text-on-primary px-10 py-4 rounded-lg font-bold uppercase tracking-wide text-sm hover:brightness-110 flex justify-center items-center gap-2 transition-all shadow-[0_0_20px_rgba(78,222,163,0.3)]">
                      <Upload size={18} /> Ingest {importType === 'options' ? 'Options' : importType === 'indicator' ? 'Indicator' : importType === 'signal' ? 'Signal' : 'Spot/Index'} Data
                    </button>
                    {previewLoading && <span className="text-xs text-primary animate-pulse flex items-center gap-2"><Upload size={12} className="animate-bounce" /> Updating Preview...</span>}
                  </div>
                </form>
              )}

              {/* Real-time Filtered Preview Table — requires active file */}
              {!isUploading && selectedFile && previewData.length > 0 && (
                <div className="mt-8 animate-in slide-in-from-bottom-4">
                  <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                    <Database size={16} className="text-primary" /> Live Data Preview
                  </h3>
                  <div className="overflow-x-auto overflow-y-auto max-h-[70vh] rounded-lg border border-white/10 bg-surface-container-lowest">
                    {(() => {
                      // Define all possible columns and their data access logic
                      // All possible preview columns across all import types (options, indicator, spot, signal).
                      // Only columns that have data in the first preview row are rendered.
                      // REUSABLE: Add new import-type columns here as new types are added.
                      const columnConfigs = [
                        { label: "Date", key: "date", fallback: (row: any) => row.Calculated_Date || (row.dateTime ? row.dateTime.split(/[ T]/)[0] : "") },
                        { label: "Time", key: "time", fallback: (row: any) => row.Calculated_Time || (row.dateTime ? row.dateTime.split(/[ T]/)[1]?.split(/[+-]/)[0] : "") },
                        { label: "Calculated Date", key: "Calculated_Date" },
                        { label: "Calculated Time", key: "Calculated_Time" },
                        { label: "Open", key: "open" },
                        { label: "High", key: "high" },
                        { label: "Low", key: "low" },
                        { label: "Close", key: "close" },
                        { label: "Volume", key: "volume" },
                        { label: "Exchange", key: "exchange" },
                        { label: "Stock", key: "stock" },
                        { label: "Script", key: "script" },
                        { label: "Type", key: "type" },
                        { label: "Expiry", key: "expiry" },
                        { label: "Price", key: "price" },
                        { label: "Buy Signal", key: "buySignal" },
                        { label: "Sell Signal", key: "sellSignal" },
                        { label: "Indicator Name", key: "indicatorName" },
                        // Signal-specific columns
                        { label: "Signal Provider", key: "signal_provider" },
                        { label: "Trade Type", key: "trade_type" },
                        { label: "Signal", key: "signal" },
                        { label: "Entry Type", key: "entry_type" },
                        { label: "Entry Price", key: "entry_price" },
                        { label: "Stop Loss", key: "sl" },
                        { label: "Target 1", key: "target_1" },
                        { label: "Target 2", key: "target_2" },
                        { label: "Target 3", key: "target_3" },
                        { label: "Target 4", key: "target_4" },
                        { label: "Target 5", key: "target_5" },
                        { label: "Updated By", key: "updatedBy" },
                      ];

                      // Determine which columns have data in the preview set
                      const activeColumns = columnConfigs.filter(col => {
                        const firstRow = previewData[0];
                        if (firstRow[col.key] !== undefined && firstRow[col.key] !== null) return true;
                        if (col.fallback && col.fallback(firstRow)) return true;
                        return false;
                      });

                      return (
                        <table className="w-full text-left text-sm text-slate-300 relative">
                          <thead className="text-xs uppercase bg-surface-container-low text-slate-400 sticky top-0 z-10 shadow-md">
                            <tr>
                              {activeColumns.map((col) => (
                                <th key={col.label} className="px-4 py-3 font-bold whitespace-nowrap">{col.label}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {previewData.map((row, i) => (
                              <tr key={i} className="border-b border-white/5 hover:bg-white/5">
                                {activeColumns.map((col) => {
                                  let val = row[col.key];
                                  if ((val === undefined || val === null) && col.fallback) {
                                    val = col.fallback(row);
                                  }
                                  return (
                                    <td key={col.label} className="px-4 py-2 whitespace-nowrap">
                                      {val !== undefined && val !== null ? String(val) : "—"}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      );
                    })()}
                  </div>
                  <p className="text-[10px] text-slate-500 mt-2 text-right">Showing top 50 rows based on current filters.</p>
                </div>
              )}

              {uploadStatus && !isUploading && (
                <div className="p-4 bg-primary/10 border border-primary/20 text-primary rounded-md text-sm font-medium animate-in fade-in slide-in-from-bottom-2">
                  {uploadStatus}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB: Validator Form */}
        {activeTab === "validator" && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <h2 className="text-3xl font-headline font-black mb-6 flex items-center gap-3">
              <Settings className="text-primary" size={28} /> Indicator Validator
            </h2>
            <div className="glass-card border border-white/5 p-8 rounded-xl relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-50"></div>

              <div className="space-y-8">

                <div className="mb-2 p-4 bg-surface-container-low border border-primary/20 rounded-lg text-sm text-slate-300">
                  <h4 className="font-bold text-primary mb-2 flex items-center gap-2"><Info size={16} /> How to configure the Validator</h4>
                  <ul className="list-disc list-inside space-y-1">
                    <li>Ensure both Indicator Data and Options/Spot Data share overlapping dates in the database.</li>
                    <li>Select the Indicator and Stock you want to backtest.</li>
                    <li>Choose your Strike Selection method (ATM requires Spot data).</li>
                    <li>Set precise Entry and Exit rules based on indicator signals and time logic.</li>
                  </ul>
                </div>

                {/* SECTION 1: Base Configuration */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
                      Indicator <InfoTooltip text="The technical indicator generating Buy/Sell signals." />
                    </label>
                    <select value={valConfig.indicator} onChange={(e) => setValConfig({ ...valConfig, indicator: e.target.value })}
                      className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50">
                      {indicatorOptions.length > 0
                        ? indicatorOptions.map(i => <option key={i} value={i}>{i}</option>)
                        : <option value="">No indicators imported yet</option>
                      }
                    </select>
                    {indicatorOptions.length === 0 && <p className="text-[10px] text-amber-400 mt-1">Import indicator data first.</p>}
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
                      Timeframe <InfoTooltip text="The timeframe of the signals (must match ingested indicator data)." />
                    </label>
                    <select value={valConfig.timeframe || "1m"} onChange={(e) => setValConfig({ ...valConfig, timeframe: e.target.value })}
                      className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50">
                      <option value="1m">1 Minute</option>
                      <option value="5m">5 Minutes</option>
                      <option value="15m">15 Minutes</option>
                      <option value="30m">30 Minutes</option>
                      <option value="1h">1 Hour</option>
                      <option value="1d">1 Day</option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
                      Stock <span className="text-red-400 ml-1">*</span> <InfoTooltip text="The underlying index for the options (e.g. BANKNIFTY)." />
                    </label>
                    <select value={valConfig.stock} onChange={(e) => setValConfig({ ...valConfig, stock: e.target.value })}
                      className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50">
                      <option value="NIFTY">NIFTY</option>
                      <option value="BANKNIFTY">BANKNIFTY</option>
                      <option value="FINNIFTY">FINNIFTY</option>
                      <option value="SENSEX">SENSEX</option>
                    </select>
                  </div>
                </div>

                <div className="border-t border-white/5 pt-8">
                  {/* SECTION 2: Date Range */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
                        Start Date <InfoTooltip text="Begin backtest on this date." />
                      </label>
                      <input type="date" value={valConfig.startDate} onChange={(e) => setValConfig({ ...valConfig, startDate: e.target.value })} className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50 [color-scheme:dark]" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
                        End Date <InfoTooltip text="End backtest on this date." />
                      </label>
                      <input type="date" value={valConfig.endDate} onChange={(e) => setValConfig({ ...valConfig, endDate: e.target.value })} className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50 [color-scheme:dark]" />
                    </div>
                  </div>
                </div>

                <div className="border-t border-white/5 pt-8">
                  {/* SECTION 3: Strike Selection & Rounding */}
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
                        Script (ATM) <InfoTooltip text="Choose Specific to type a script name, or ATM to auto-calculate based on Spot price." />
                      </label>
                      <select value={valConfig.script} onChange={(e) => setValConfig({ ...valConfig, script: e.target.value })}
                        className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50">
                        <option value="ATM">ATM</option>
                        <option value="ATM+">ATM+</option>
                        <option value="ATM-">ATM-</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className={`text-xs font-bold uppercase tracking-wider flex items-center ${valConfig.script === "ATM" ? "text-slate-600" : "text-primary"}`}>
                        ATM Offset <InfoTooltip text="Shift the strike by N points from ATM." />
                      </label>
                      <select
                        value={valConfig.atmOffset}
                        onChange={(e) => setValConfig({ ...valConfig, atmOffset: e.target.value })}
                        disabled={valConfig.script === "ATM"}
                        className={`border rounded px-3 py-3 text-sm focus:outline-none transition-all ${valConfig.script === "ATM" ? "bg-surface-container-lowest border-white/5 text-slate-600 cursor-not-allowed" : "bg-surface-container-low border-primary/30 text-white focus:border-primary"}`}
                      >
                        {atmMultiples.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
                        Apply On <InfoTooltip text="Options - Calls, Puts, Both" />
                      </label>
                      <select value={valConfig.applyOn} onChange={(e) => setValConfig({ ...valConfig, applyOn: e.target.value })}
                        className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50">
                        <option value="Call">Call</option>
                        <option value="Put">Put</option>
                        <option value="Both">Both</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
                        Execution Price <InfoTooltip text="Price point to execute on." />
                      </label>
                      <select value={valConfig.executionPrice} onChange={(e) => setValConfig({ ...valConfig, executionPrice: e.target.value })}
                        className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50">
                        <option value="Open">Open</option>
                        <option value="High">High</option>
                        <option value="Low">Low</option>
                        <option value="Close">Close</option>
                        <option value="Open-Close Average">Open-Close Average</option>
                        <option value="High-Low Average">High-Low Average</option>
                      </select>
                    </div>

                    <div className="flex flex-col gap-1 md:col-span-2">
                      <label className="text-xs text-slate-400 font-bold uppercase tracking-wider flex items-center">
                        Trade Amount <InfoTooltip text="Capital allocation or fixed Lots." />
                      </label>
                      <div className="flex gap-2">
                        <select value={valConfig.tradeAmountType} onChange={(e) => setValConfig({ ...valConfig, tradeAmountType: e.target.value })}
                          className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50 w-full max-w-[150px]">
                          <option value="Capital">Capital</option>
                          <option value="Lots">Lots</option>
                          <option value="None">None</option>
                        </select>
                        <input type="number"
                          value={valConfig.tradeAmountLots}
                          onChange={(e) => setValConfig({ ...valConfig, tradeAmountLots: e.target.value })}
                          disabled={valConfig.tradeAmountType === "None"}
                          placeholder={valConfig.tradeAmountType === "Capital" ? "e.g. 50000" : "e.g. 2"}
                          className={`border rounded px-3 py-3 text-sm focus:outline-none flex-1 ${valConfig.tradeAmountType !== "None" ? "bg-surface-container-low border-white/10 text-white" : "bg-surface-container-lowest border-white/5 text-slate-600 cursor-not-allowed"}`}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="border-t border-white/5 pt-8">
                  {/* SECTION 4: Execution Rules */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-12">

                    {/* Entry Rules Group */}
                    <div className="space-y-4">
                      <h4 className="text-[10px] text-primary font-black uppercase tracking-[0.2em] mb-2 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span> Entry Rules
                      </h4>
                      <div className="grid grid-cols-1 gap-4 bg-white/[0.02] p-4 rounded-lg border border-white/5">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase flex items-center">
                            Signal <InfoTooltip text="Wait for this specific signal from the indicator to enter a trade." />
                          </label>
                          <select value={valConfig.entrySignal} onChange={(e) => {
                            const newEntry = e.target.value;
                            const newExit = newEntry === "Buy" ? "Sell" : "Buy";
                            setValConfig({ ...valConfig, entrySignal: newEntry, exitSignal: newExit });
                          }}
                            className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:border-primary/50">
                            <option value="Buy">Buy</option>
                            <option value="Sell">Sell</option>
                          </select>
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase flex items-center">
                            Time <InfoTooltip text="Execute at the exact minute of the signal, or wait for the Next Candle." />
                          </label>
                          <select value={valConfig.entryTime} onChange={(e) => setValConfig({ ...valConfig, entryTime: e.target.value })}
                            className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:border-primary/50">
                            <option value="At Signal">At Signal</option>
                            <option value="Next Candle">Next Candle</option>
                          </select>
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase flex items-center">
                            Repetitive Signals <InfoTooltip text="Ignore repetitive Signals, Add Qty" />
                          </label>
                          <select value={valConfig.repetitiveSignals} onChange={(e) => setValConfig({ ...valConfig, repetitiveSignals: e.target.value })}
                            className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:border-primary/50">
                            <option value="Ignore repetitive Signals">Ignore repetitive Signals</option>
                            <option value="Add Qty">Add Qty</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* Exit Rules Group */}
                    <div className="space-y-4">
                      <h4 className="text-[10px] text-slate-400 font-black uppercase tracking-[0.2em] mb-2 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span> Exit Rules
                      </h4>
                      <div className="grid grid-cols-1 gap-4 bg-white/[0.02] p-4 rounded-lg border border-white/5">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase flex items-center">
                            Signal <InfoTooltip text="Wait for this signal to exit the trade." />
                          </label>
                          <select value={valConfig.exitSignal} onChange={(e) => setValConfig({ ...valConfig, exitSignal: e.target.value })}
                            className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:border-primary/50">
                            <option value="Buy">Buy</option>
                            <option value="Sell">Sell</option>
                          </select>
                          {valConfig.entrySignal === valConfig.exitSignal && (
                            <div className="text-[#ff0055] drop-shadow-[0_0_8px_rgba(255,0,85,0.8)] animate-pulse text-[10px] font-bold mt-1 uppercase flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-[#ff0055] shadow-[0_0_8px_rgba(255,0,85,1)]"></span>
                              Warning: Not opposite to Entry Signal
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase flex items-center">
                            Time <InfoTooltip text="Exit at the exact minute of the signal, or wait for the Next Candle." />
                          </label>
                          <select value={valConfig.exitTime} onChange={(e) => setValConfig({ ...valConfig, exitTime: e.target.value })}
                            className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:border-primary/50">
                            <option value="At Signal">At Signal</option>
                            <option value="Next Candle">Next Candle</option>
                            <option value="End of Day">End of Day</option>
                          </select>
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500 font-bold uppercase flex items-center">
                            Position Open on End Date <InfoTooltip text="Action when End Date is reached." />
                          </label>
                          <select value={valConfig.positionOpenEndAction} onChange={(e) => setValConfig({ ...valConfig, positionOpenEndAction: e.target.value })}
                            className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:border-primary/50">
                            <option value="Ignore last Entry">Ignore last Entry</option>
                            <option value="Take next Entry beyond End Date">Take next Entry beyond End Date</option>
                          </select>
                        </div>
                      </div>
                    </div>

                  </div>
                </div>

              </div>

              <div className="mt-12 pt-8 border-t border-white/10 flex justify-center">
                <button onClick={handleValidateSubmit} className="bg-primary text-on-primary px-16 py-4 rounded-lg font-black uppercase tracking-widest text-sm hover:brightness-110 flex items-center gap-3 transition-all shadow-[0_0_30px_rgba(78,222,163,0.3)] hover:scale-105 active:scale-95">
                  <Play size={20} fill="currentColor" /> Validate Performance
                </button>
              </div>

              {validatorStatus && (
                <div className="mt-8 p-4 bg-primary/10 border border-primary/20 text-primary rounded-md text-sm text-center font-bold animate-in zoom-in-95">
                  {validatorStatus}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB: Results */}
        {activeTab === "results" && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-6">

            {/* Header row */}
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-3xl font-headline font-black flex items-center gap-3">
                <BarChart2 className="text-primary" size={28} /> Performance Ledger
              </h2>
              {/* History selector */}
              {reportsList.length > 0 && (
                <select
                  onChange={e => handleLoadReport(e.target.value)}
                  className="bg-surface-container-low border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50 min-w-[260px]"
                >
                  <option value="">📂 Load a past report…</option>
                  {reportsList.map((r: any) => (
                    <option key={r.id} value={r.id}>
                      {r.stock} | {r.indicatorName} ({r.timeframe}) | {r.testDate.slice(0, 10)} | {r.totalTrades} trades
                    </option>
                  ))}
                </select>
              )}
            </div>

            {report ? (
              <div className="space-y-6">

                {/* Export Button Group */}
                <div className="flex flex-wrap gap-3 justify-end">
                  <button onClick={() => handleExport("csv")}
                    className="flex items-center gap-2 bg-surface-container border border-white/10 hover:border-primary/50 text-slate-300 hover:text-primary px-4 py-2 rounded-lg text-sm font-bold transition-all">
                    <FileText size={14} /> Download CSV
                  </button>
                  <button onClick={() => handleExport("pdf")}
                    className="flex items-center gap-2 bg-surface-container border border-white/10 hover:border-primary/50 text-slate-300 hover:text-primary px-4 py-2 rounded-lg text-sm font-bold transition-all">
                    <FileText size={14} /> Download PDF
                  </button>
                  <button onClick={handleCopySummary}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all border ${copied ? "bg-primary text-on-primary border-primary" : "bg-surface-container border-white/10 text-slate-300 hover:border-primary/50 hover:text-primary"}`}>
                    {copied ? "✓ Copied!" : "⎘ Copy Summary"}
                  </button>
                </div>

                {/* Phase 1 — 6 KPI Cards */}
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                  {[
                    { label: "Net P&L", value: `${report.totalProfit >= 0 ? "+" : ""}${report.totalProfit} pts`, color: report.totalProfit >= 0 ? "text-primary" : "text-error" },
                    { label: "Win Rate", value: `${report.winRate}%`, color: "text-white" },
                    { label: "Total Trades", value: report.totalTrades, color: "text-white" },
                    { label: "Max Drawdown", value: `${report.maxDrawdown ?? 0}%`, color: "text-secondary" },
                    { label: "Profit Factor", value: `${report.profitFactor ?? 0}x`, color: report.profitFactor >= 1 ? "text-primary" : "text-error" },
                    { label: "Avg Trade", value: `${report.avgTrade ?? 0} pts`, color: report.avgTrade >= 0 ? "text-primary" : "text-error" },
                  ].map((kpi: any) => (
                    <div key={kpi.label} className="glass-card border border-white/5 p-4 rounded-xl flex flex-col items-center text-center relative overflow-hidden">
                      <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
                      <div className="text-slate-400 text-[10px] font-bold uppercase tracking-widest mb-2">{kpi.label}</div>
                      <div className={`text-2xl font-black ${kpi.color}`}>{kpi.value}</div>
                    </div>
                  ))}
                </div>

                {/* Phase 3 — Equity Curve */}
                <div className="glass-card border border-white/5 p-6 rounded-xl relative overflow-hidden">
                  <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-50" />
                  <h3 className="text-lg font-bold mb-4 flex items-center gap-2"><BarChart2 size={16} className="text-primary" /> Equity Curve</h3>
                  <div className="h-[300px] w-full rounded-lg overflow-hidden bg-surface-container-lowest">
                    <Plot
                      data={[
                        {
                          x: sortedTrades.map((_: any, i: number) => `T${i + 1}`),
                          y: sortedTrades.reduce((acc: number[], curr: any) => {
                            acc.push((acc.length > 0 ? acc[acc.length - 1] : 0) + curr.points);
                            return acc;
                          }, []),
                          type: "scatter", mode: "lines+markers",
                          marker: { color: "#4edea3", size: 5 },
                          line: { color: "#4edea3", width: 2 },
                          fill: "tozeroy", fillcolor: "rgba(78,222,163,0.08)",
                          name: "Cumulative P&L",
                        },
                        {
                          x: [0, sortedTrades.length + 1], y: [0, 0], mode: "lines",
                          line: { color: "rgba(255,255,255,0.15)", dash: "dash", width: 1 },
                          showlegend: false
                        },
                      ]}
                      layout={{
                        autosize: true, paper_bgcolor: "transparent", plot_bgcolor: "transparent",
                        font: { color: "#dae2fd" }, margin: { l: 50, r: 20, t: 10, b: 40 },
                        xaxis: { showgrid: false, color: "#45464d" },
                        yaxis: { gridcolor: "#171f33", color: "#45464d", zeroline: false },
                        showlegend: false,
                      }}
                      useResizeHandler style={{ width: "100%", height: "100%" }}
                      config={{ displayModeBar: false }}
                    />
                  </div>
                </div>

                {/* Phase 2 — Sortable Trade Log Table */}
                <div className="glass-card border border-white/5 p-6 rounded-xl relative overflow-hidden">
                  <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-50" />
                  <h3 className="text-lg font-bold mb-4 flex items-center gap-2"><Database size={16} className="text-primary" /> Trade Log</h3>
                  <div className="overflow-x-auto overflow-y-auto max-h-[60vh] rounded-lg border border-white/10">
                    <table className="w-full text-left text-xs text-slate-300 relative min-w-[900px]">
                      <thead className="text-[10px] uppercase bg-surface-container-low text-slate-400 sticky top-0 z-10">
                        <tr>
                          {[
                            { key: "tradeId", label: "#" },
                            { key: "script", label: "Script" },
                            { key: "atmProof", label: "ATM Proof" },
                            { key: "entryTime", label: "Entry Time" },
                            { key: "entryType", label: "Type" },
                            { key: "entryPrice", label: "Entry Px" },
                            { key: "exitTime", label: "Exit Time" },
                            { key: "exitPrice", label: "Exit Px" },
                            { key: "exitReason", label: "Exit Reason" },
                            { key: "duration", label: "Duration" },
                            { key: "quantity", label: "Qty" },
                            { key: "tradeValue", label: "Value" },
                            { key: "points", label: "Points" },
                            { key: "profit", label: "Net P&L" },
                            { key: "pnlPct", label: "P&L %" },
                            { key: "_verify", label: "Verify" },
                          ].map(col => (
                            <th key={col.key}
                              onClick={() => col.key !== "_verify" && handleSort(col.key)}
                              className={`px-3 py-3 font-bold whitespace-nowrap ${col.key !== "_verify" ? "cursor-pointer hover:text-primary select-none" : ""}`}>
                              {col.label}
                              {sortCol === col.key && <span className="ml-1">{sortDir === "asc" ? "↑" : "↓"}</span>}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedTrades.map((t: any, i: number) => (
                          <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                            <td className="px-3 py-2 text-slate-500">{t.tradeId}</td>
                            <td className="px-3 py-2 font-mono text-[10px] text-primary">{t.script}</td>
                            <td className="px-3 py-2 text-slate-400 text-[10px]">{t.atmProof}</td>
                            <td className="px-3 py-2 text-[10px]">{t.entryTime?.slice(0, 16).replace("T", " ")}</td>
                            <td className="px-3 py-2"><span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${t.entryType === "Buy" ? "bg-primary/20 text-primary" : "bg-secondary/20 text-secondary"}`}>{t.entryType}</span></td>
                            <td className="px-3 py-2 font-mono">{t.entryPrice?.toFixed(2)}</td>
                            <td className="px-3 py-2 text-[10px]">{t.exitTime?.slice(0, 16).replace("T", " ")}</td>
                            <td className="px-3 py-2 font-mono">{t.exitPrice?.toFixed(2)}</td>
                            <td className="px-3 py-2 text-slate-400 text-[10px]">{t.exitReason || t.executionNote}</td>
                            <td className="px-3 py-2 text-slate-400">{t.duration}</td>
                            <td className="px-3 py-2 text-slate-400">{t.quantity || 1}</td>
                            <td className="px-3 py-2 font-mono">{t.tradeValue?.toFixed(2)}</td>
                            <td className={`px-3 py-2 font-mono font-bold ${t.points >= 0 ? 'text-primary' : 'text-[#ffb4ab]'}`}>
                              {t.points >= 0 ? '+' : ''}{t.points?.toFixed(2)}
                            </td>
                            <td className={`px-3 py-2 font-mono font-bold ${t.profit >= 0 ? 'text-primary' : 'text-[#ffb4ab]'}`}>
                              {t.profit >= 0 ? '+' : ''}{t.profit?.toFixed(2)}
                            </td>
                            <td className="px-3 py-2">{t.pnlPct}%</td>
                            <td className="px-3 py-2">
                              <button onClick={() => handleVerify(t)} className="text-[10px] uppercase tracking-wider font-bold bg-white/5 hover:bg-white/10 px-2 py-1 rounded text-white transition-colors">
                                Verify
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Report with Excel Export Table */}
                <div className="glass-card border border-white/5 p-6 rounded-xl relative overflow-hidden">
                  <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-50" />
                  <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                    <h3 className="text-lg font-bold flex items-center gap-2">
                      <FileText size={16} className="text-primary" /> Report with Excel Export
                    </h3>
                    <button
                      onClick={() => {
                        if (!report?.reportId) return;
                        const url = `http://127.0.0.1:8000/api/results/export-excel?resultId=${report.reportId}`;
                        const a = document.createElement("a");
                        a.href = url;
                        a.click();
                      }}
                      className="flex items-center gap-2 bg-green-900/40 border border-green-500/40 hover:border-green-400 text-green-400 hover:text-green-300 px-4 py-2 rounded-lg text-sm font-bold transition-all"
                    >
                      <FileText size={14} /> Download Excel (.xlsx)
                    </button>
                  </div>

                  <div className="overflow-x-auto overflow-y-auto max-h-[60vh] rounded-lg border border-white/10">
                    <table className="w-full text-left text-xs text-slate-300 relative min-w-[1200px]">
                      <thead className="text-[10px] uppercase bg-yellow-400/90 text-black sticky top-0 z-10">
                        <tr>
                          {[
                            "Final Entry Script", "Option Type", "Expiry",
                            "Entry Time", "Entry AT (Value)", "Buy Amount",
                            "Exit Time", "Exit At (Value)", "Sell Amount",
                            "PnL Points", "PnL Amount", "PnL Percentage",
                            "Highest", "High Percentage",
                            "Lowest", "Lowest Percentage",
                          ].map(col => (
                            <th key={col} className="px-3 py-3 font-black whitespace-nowrap border-r border-black/10 last:border-r-0">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedTrades.length === 0 ? (
                          <tr>
                            <td colSpan={16} className="px-4 py-8 text-center text-slate-500">
                              No trades to display. Run the validator first.
                            </td>
                          </tr>
                        ) : (
                          sortedTrades.map((t: any, i: number) => {
                            const isPnlPositive = (t.points ?? 0) >= 0;
                            return (
                              <tr key={i} className="border-t border-white/5 hover:bg-white/[0.03] transition-colors">
                                <td className="px-3 py-2 font-mono text-white font-bold">{t.script}</td>
                                <td className="px-3 py-2 text-center">
                                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${(t.optionType || "").toLowerCase().includes("put") ? "bg-red-900/40 text-red-400" : "bg-green-900/40 text-green-400"}`}>
                                    {t.optionType || "—"}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-slate-400">{t.expiry || "—"}</td>
                                <td className="px-3 py-2 font-mono text-slate-300">{(t.entryTime || "").replace("T", " ")}</td>
                                <td className="px-3 py-2 text-right font-mono">{t.entryPrice?.toFixed(2)}</td>
                                <td className="px-3 py-2 text-right font-mono">{t.tradeValue?.toFixed(2)}</td>
                                <td className="px-3 py-2 font-mono text-slate-300">{(t.exitTime || "").replace("T", " ")}</td>
                                <td className="px-3 py-2 text-right font-mono">{t.exitPrice?.toFixed(2)}</td>
                                <td className="px-3 py-2 text-right font-mono">
                                  {t.sellAmount === "-" ? "—" : t.sellAmount != null ? Number(t.sellAmount).toFixed(2) : "—"}
                                </td>
                                <td className={`px-3 py-2 text-right font-mono font-bold ${isPnlPositive ? "text-primary" : "text-red-400"}`}>
                                  {(t.points ?? 0) >= 0 ? "+" : ""}{t.points?.toFixed(2)}
                                </td>
                                <td className={`px-3 py-2 text-right font-mono font-bold ${isPnlPositive ? "text-primary" : "text-red-400"}`}>
                                  {(t.profit ?? 0) >= 0 ? "+" : ""}{t.profit?.toFixed(2)}
                                </td>
                                <td className={`px-3 py-2 text-right font-mono ${isPnlPositive ? "text-primary" : "text-red-400"}`}>
                                  {(t.pnlPct ?? 0) >= 0 ? "+" : ""}{t.pnlPct?.toFixed(2)}%
                                </td>
                                {/* Highest (raw high value) */}
                                <td className="px-3 py-2 text-right font-mono text-slate-200">
                                  {t.highestHigh != null ? t.highestHigh.toFixed(2) : "—"}
                                </td>
                                {/* High Percentage = highestHigh / entryPrice */}
                                <td className="px-3 py-2 text-right font-mono text-green-400">
                                  {t.highestHighPct != null ? `${t.highestHighPct.toFixed(4)}%` : "—"}
                                </td>
                                {/* Lowest (raw low value) */}
                                <td className="px-3 py-2 text-right font-mono text-slate-200">
                                  {t.lowestLow != null ? t.lowestLow.toFixed(2) : "—"}
                                </td>
                                {/* Lowest Percentage = lowestLow / entryPrice */}
                                <td className="px-3 py-2 text-right font-mono text-red-400">
                                  {t.lowestLowPct != null ? `${t.lowestLowPct.toFixed(4)}%` : "—"}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

              </div>
            ) : (
              <div className="glass-card border border-white/5 p-12 rounded-xl text-center text-slate-500">
                <BarChart2 size={48} className="mx-auto mb-4 opacity-50" />
                <p className="font-bold text-lg mb-2">No Results Yet</p>
                <p className="text-sm">Run the Indicator Validator to generate a performance report.</p>
              </div>
            )}

            {/* Phase 3 — Trade Verify Modal */}
            {verifyTrade && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setVerifyTrade(null)}>
                <div className="bg-surface-container border border-white/10 rounded-2xl p-6 w-full max-w-3xl mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-lg font-bold text-white font-mono">{verifyTrade.script}</h3>
                      <p className="text-xs text-slate-400">{verifyTrade.atmProof}</p>
                    </div>
                    <button onClick={() => setVerifyTrade(null)} className="text-slate-400 hover:text-white text-xl font-bold transition-colors">✕</button>
                  </div>
                  <div className="grid grid-cols-4 gap-3 mb-4">
                    {[
                      { label: "Entry", value: verifyTrade.entryPrice?.toFixed(2) },
                      { label: "Exit", value: verifyTrade.exitPrice?.toFixed(2) },
                      { label: "Points", value: `${verifyTrade.points >= 0 ? "+" : ""}${verifyTrade.points?.toFixed(2)}`, color: verifyTrade.points >= 0 ? "text-green-400" : "text-red-400" },
                      { label: "Duration", value: verifyTrade.duration },
                    ].map((kpi: any) => (
                      <div key={kpi.label} className="bg-surface-container-low rounded-lg p-3 text-center">
                        <div className="text-[10px] text-slate-400 uppercase mb-1">{kpi.label}</div>
                        <div className={`font-bold font-mono ${kpi.color || "text-white"}`}>{kpi.value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="h-[280px] bg-surface-container-lowest rounded-lg overflow-hidden">
                    {verifyLoading ? (
                      <div className="flex items-center justify-center h-full text-primary animate-pulse">Loading chart data…</div>
                    ) : verifyOHLC.length > 0 ? (
                      <Plot
                        data={[
                          {
                            type: "candlestick" as any,
                            x: verifyOHLC.map((c: any) => c.dateTime),
                            open: verifyOHLC.map((c: any) => c.open),
                            high: verifyOHLC.map((c: any) => c.high),
                            low: verifyOHLC.map((c: any) => c.low),
                            close: verifyOHLC.map((c: any) => c.close),
                            increasing: { line: { color: "#4edea3" } },
                            decreasing: { line: { color: "#ffb4ab" } },
                            name: verifyTrade.script,
                          },
                          {
                            type: "scatter", mode: "markers",
                            x: [verifyTrade.entryTime], y: [verifyTrade.entryPrice],
                            marker: { color: "#4edea3", size: 12, symbol: "triangle-up" }, name: "Entry"
                          },
                          {
                            type: "scatter", mode: "markers",
                            x: [verifyTrade.exitTime], y: [verifyTrade.exitPrice],
                            marker: { color: "#ffb4ab", size: 12, symbol: "triangle-down" }, name: "Exit"
                          },
                        ]}
                        layout={{
                          autosize: true, paper_bgcolor: "transparent", plot_bgcolor: "transparent",
                          font: { color: "#dae2fd" }, margin: { l: 50, r: 20, t: 10, b: 40 },
                          xaxis: { showgrid: false, color: "#45464d", rangeslider: { visible: false } },
                          yaxis: { gridcolor: "#171f33", color: "#45464d" },
                          showlegend: true, legend: { bgcolor: "transparent", font: { color: "#909097", size: 10 } },
                        }}
                        useResizeHandler style={{ width: "100%", height: "100%" }}
                        config={{ displayModeBar: false }}
                      />
                    ) : (
                      <div className="flex items-center justify-center h-full text-slate-500 text-sm">
                        No OHLC data found for this trade window.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  );
}

