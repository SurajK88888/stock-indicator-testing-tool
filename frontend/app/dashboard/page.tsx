"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { Upload, Database, Settings, BarChart2, Play, FileText } from "lucide-react";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("ingestion");
  
  // -- Data Ingestion State --
  // FIX: importType now includes "spot" (3rd required import type)
  const [importType, setImportType] = useState<"options" | "indicator" | "spot">("options");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");

  // FIX: Separate header arrays per import type — shared state caused cross-form pollution
  const [optionsHeaders, setOptionsHeaders] = useState<string[]>([]);
  const [indicatorHeaders, setIndicatorHeaders] = useState<string[]>([]);
  const [spotHeaders, setSpotHeaders] = useState<string[]>([]);
  const activeHeaders = importType === "options" ? optionsHeaders : importType === "indicator" ? indicatorHeaders : spotHeaders;

  // -- Options Import State (FIX: controlled dateStart/dateEnd/timeStart/timeEnd) --
  const [optionsMap, setOptionsMap] = useState({
    dateTime: "", date: "", time: "", open: "", high: "", low: "", close: "", volume: "", script: "",
    dateStart: "0", dateEnd: "10", timeStart: "0", timeEnd: "8",
    exchange: "NSE", exchangeOther: "",
    stock: "NIFTY", stockOther: "",
    type: "Call", typeOther: "",
    expiry: "",
    startDate: "", endDate: "",
  });

  // -- Indicator Import State --
  const [indicatorMap, setIndicatorMap] = useState({
    indicator: "", indicatorOther: "",
    dateTime: "", date: "", time: "", open: "", high: "", low: "", close: "", volume: "", buy: "", sell: "",
    dateStart: "0", dateEnd: "10", timeStart: "0", timeEnd: "8",
    exchange: "NSE", exchangeOther: "",
    stock: "NIFTY", stockOther: "",
    startDate: "", endDate: "",
  });

  // -- Spot Data Import State (NEW — required so ATM calculator can find spot prices) --
  const [spotMap, setSpotMap] = useState({
    dateTime: "", date: "", time: "", price: "",
    dateStart: "0", dateEnd: "10", timeStart: "0", timeEnd: "8",
    stock: "NIFTY", stockOther: "",
    startDate: "", endDate: "",
  });

  // -- Validator Config State (FIX: added interval + roundingMethod per spec) --
  const [valConfig, setValConfig] = useState({
    indicator: "",
    startDate: "", endDate: "",
    script: "ATM+",
    atmOffset: "100",
    interval: "50",           // 50=NIFTY, 100=BANKNIFTY — configurable per spec
    roundingMethod: "closest", // "closest" | "floor" | "ceiling" — per spec
    entrySignal: "Buy", exitSignal: "Sell",
    entryTime: "Next Candle", exitTime: "At Signal",
    entryPoint: "Open", exitPoint: "Close"
  });

  // FIX: Dynamic indicator list fetched from DB, not hardcoded RSI/MACD
  const [indicatorOptions, setIndicatorOptions] = useState<string[]>([]);
  const [validatorStatus, setValidatorStatus] = useState("");

  // -- Results State --
  const [report, setReport] = useState<any>(null);

  // ATM Multiples: 50 to 2000 in multiples of 50 (per requirement spec)
  const atmMultiples = Array.from({length: 40}, (_, i) => String((i + 1) * 50));

  // FIX: stores headers in per-type arrays, not a single shared array
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];
    setSelectedFile(file);
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

  // FIX: real POST /api/ingest — no more setTimeout mock
  const handleIngestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) { setUploadStatus("Please select a file first."); return; }
    setUploadStatus("Ingesting data...");
    const fd = new FormData();
    fd.append("file", selectedFile);
    fd.append("dataType", importType);
    let mappings: Record<string,string> = {};
    let stock = "", exchange = "", optionType = "", expiry = "", indicatorName = "", startDate = "", endDate = "";
    if (importType === "options") {
      const m = optionsMap;
      mappings = { [m.dateTime]:"dateTime",[m.date]:"date",[m.time]:"time",[m.open]:"open",[m.high]:"high",[m.low]:"low",[m.close]:"close",[m.volume]:"volume",[m.script]:"script" };
      exchange = m.exchange === "Other" ? m.exchangeOther : m.exchange;
      stock = m.stock === "Other" ? m.stockOther : m.stock;
      optionType = m.type === "Other" ? m.typeOther : m.type;
      expiry = m.expiry; startDate = m.startDate; endDate = m.endDate;
    } else if (importType === "indicator") {
      const m = indicatorMap;
      mappings = { [m.dateTime]:"dateTime",[m.date]:"date",[m.time]:"time",[m.open]:"open",[m.high]:"high",[m.low]:"low",[m.close]:"close",[m.volume]:"volume",[m.buy]:"buySignal",[m.sell]:"sellSignal" };
      exchange = m.exchange === "Other" ? m.exchangeOther : m.exchange;
      stock = m.stock === "Other" ? m.stockOther : m.stock;
      indicatorName = m.indicator === "Other" ? m.indicatorOther : m.indicator;
      startDate = m.startDate; endDate = m.endDate;
    } else {
      const m = spotMap;
      mappings = { [m.dateTime]:"dateTime",[m.date]:"date",[m.time]:"time",[m.price]:"price" };
      stock = m.stock === "Other" ? m.stockOther : m.stock;
      startDate = m.startDate; endDate = m.endDate;
    }
    const clean = Object.fromEntries(Object.entries(mappings).filter(([k,v]) => k && v));
    fd.append("mappings", JSON.stringify(clean));
    if (exchange) fd.append("exchange", exchange);
    if (stock) fd.append("stock", stock);
    if (optionType) fd.append("optionType", optionType);
    if (expiry) fd.append("expiry", expiry);
    if (indicatorName) fd.append("indicatorName", indicatorName);
    if (startDate) fd.append("startDate", startDate);
    if (endDate) fd.append("endDate", endDate);
    try {
      const res = await fetch("http://127.0.0.1:8000/api/ingest", { method: "POST", body: fd });
      const data = await res.json();
      setUploadStatus(data.error ? "Error: " + data.error : data.message);
    } catch { setUploadStatus("Failed to contact backend. Ensure uvicorn is running."); }
  };

  // FIX: real POST /api/validate + job polling — no more mock setTimeout
  const handleValidateSubmit = async () => {
    setValidatorStatus("Submitting validation job...");
    setReport(null);
    const payload = {
      stock: valConfig.indicator,
      indicatorName: valConfig.indicator,
      offsetType: valConfig.script,
      offsetValue: valConfig.script === "ATM" ? 0 : parseInt(valConfig.atmOffset),
      interval: parseInt(valConfig.interval),
      roundingMethod: valConfig.roundingMethod,
      entrySignal: valConfig.entrySignal, exitSignal: valConfig.exitSignal,
      entryTiming: valConfig.entryTime, exitTiming: valConfig.exitTime,
      entryPoint: valConfig.entryPoint, exitPoint: valConfig.exitPoint,
      startDate: valConfig.startDate || null, endDate: valConfig.endDate || null,
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

  // Fetch dynamic indicator list when validator tab is opened
  useEffect(() => {
    if (activeTab === "validator") {
      fetch("http://127.0.0.1:8000/api/indicators")
        .then(r => r.json())
        .then(d => { if (d.indicators?.length) { setIndicatorOptions(d.indicators); if (!valConfig.indicator) setValConfig(v => ({...v, indicator: d.indicators[0]})); } })
        .catch(() => {});
    }
  }, [activeTab]);

  // UI Helper: header dropdown using the active form's own header list
  const renderHeaderDropdown = (val: string, setter: (val: string) => void, label: string, headers = activeHeaders) => (
    <div className="flex flex-col gap-1 w-full">
      <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">{label}</label>
      <select value={val} onChange={(e) => setter(e.target.value)}
        className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50">
        <option value="">Select Header</option>
        {headers.map(h => <option key={h} value={h}>{h}</option>)}
      </select>
    </div>
  );

  return (
    <div className="bg-background text-on-background min-h-screen flex flex-col font-body">
      {/* Header */}
      <header className="border-b border-white/5 bg-surface-container-lowest py-4 px-6 flex items-center justify-between sticky top-0 z-10 shadow-lg">
        <div className="flex items-center gap-3">
          <Database className="text-primary" size={20} />
          <span className="font-headline font-bold text-lg tracking-tight uppercase">Terminal <span className="text-primary">Dashboard</span></span>
        </div>
        <div className="flex gap-4">
          <button onClick={() => setActiveTab("ingestion")} className={`px-4 py-2 text-sm font-semibold rounded transition-all ${activeTab === 'ingestion' ? 'bg-primary/10 text-primary border border-primary/20 shadow-[0_0_15px_rgba(78,222,163,0.15)]' : 'text-slate-400 hover:text-white'}`}>
            <Upload size={16} className="inline mr-2" /> Data Import
          </button>
          <button onClick={() => setActiveTab("validator")} className={`px-4 py-2 text-sm font-semibold rounded transition-all ${activeTab === 'validator' ? 'bg-primary/10 text-primary border border-primary/20 shadow-[0_0_15px_rgba(78,222,163,0.15)]' : 'text-slate-400 hover:text-white'}`}>
            <Settings size={16} className="inline mr-2" /> Indicator Validator
          </button>
          <button onClick={() => setActiveTab("results")} className={`px-4 py-2 text-sm font-semibold rounded transition-all ${activeTab === 'results' ? 'bg-primary/10 text-primary border border-primary/20 shadow-[0_0_15px_rgba(78,222,163,0.15)]' : 'text-slate-400 hover:text-white'}`}>
            <BarChart2 size={16} className="inline mr-2" /> Results
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow p-8 max-w-6xl mx-auto w-full">
        
        {/* TAB: Ingestion */}
        {activeTab === "ingestion" && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <h2 className="text-3xl font-headline font-black mb-6 flex items-center gap-3">
              <Database className="text-primary" size={28}/> Data Import Mapping
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
                  {/* NEW: Spot Data — required for ATM calculator to function */}
                  <button onClick={() => setImportType("spot")}
                    className={`flex-1 py-2 px-3 text-sm font-bold rounded-md transition-all ${importType === "spot" ? "bg-primary text-on-primary shadow-lg" : "text-slate-400 hover:text-white"}`}>
                    Spot / Index Data
                  </button>
                </div>
              </div>

              {isUploading && <div className="text-sm text-primary animate-pulse flex items-center gap-2"><Upload size={14} className="animate-bounce"/> Extracting headers from file...</div>}

              {/* Mapping Forms */}
              {!isUploading && (
                <form onSubmit={handleIngestSubmit} className="space-y-8 pt-8 border-t border-white/10 animate-in fade-in zoom-in-95 duration-500">
                  
                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-1 bg-primary rounded-full"></div>
                      <h3 className="text-xl font-bold font-headline">
                        {importType === 'options' ? 'Options/Equity' : importType === 'indicator' ? 'Indicator' : 'Spot/Index'} Data — Header Mapping
                      </h3>
                    </div>
                    <div className="bg-surface-container-low p-3 rounded-lg border border-white/10 flex flex-col justify-center border-dashed hover:border-primary/50 transition-colors w-full md:w-auto">
                      <label className="block text-xs font-bold mb-2 text-slate-300 cursor-pointer flex items-center gap-2">
                        <FileText size={14} className="text-primary" /> Select {importType === 'options' ? 'Options/Equity' : importType === 'indicator' ? 'Indicator' : 'Spot/Index'} File
                      </label>
                      <input type="file" onChange={handleFileChange} className="text-sm text-slate-400 file:mr-4 file:py-1.5 file:px-3 file:rounded-full file:border-0 file:text-xs file:font-bold file:bg-primary/10 file:text-primary hover:file:bg-primary/20 cursor-pointer" />
                    </div>
                  </div>

                  {importType === "indicator" && (
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-surface-container-low/50 p-6 rounded-lg border border-white/5">
                        <div className="flex flex-col gap-1 w-full">
                          <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Indicator</label>
                          <select 
                            value={indicatorMap.indicator} 
                            onChange={(e) => setIndicatorMap({...indicatorMap, indicator: e.target.value})}
                            className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                          >
                            <option value="RSI">RSI</option>
                            <option value="MACD">MACD</option>
                            <option value="Other">Other</option>
                          </select>
                        </div>
                        {indicatorMap.indicator === "Other" && (
                          <div className="flex flex-col gap-1 w-full animate-in slide-in-from-right-4">
                            <label className="text-xs text-primary font-bold uppercase tracking-wider">Custom Indicator Name</label>
                            <input type="text" value={indicatorMap.indicatorOther} onChange={(e) => setIndicatorMap({...indicatorMap, indicatorOther: e.target.value})} className="bg-surface-container-lowest border border-primary/30 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary" placeholder="Enter indicator name" />
                          </div>
                        )}
                     </div>
                  )}

                  {importType === "options" && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      {renderHeaderDropdown(optionsMap.script, (val) => setOptionsMap({...optionsMap, script: val}), "Script")}
                      
                      <div className="flex flex-col gap-1 w-full">
                        <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Type</label>
                        <select 
                          value={optionsMap.type} 
                          onChange={(e) => setOptionsMap({...optionsMap, type: e.target.value})}
                          className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50"
                        >
                          <option value="Call">Call</option>
                          <option value="Put">Put</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                      {optionsMap.type === "Other" && (
                         <div className="flex flex-col gap-1 w-full animate-in slide-in-from-right-4">
                          <label className="text-xs text-primary font-bold uppercase tracking-wider">Custom Type</label>
                          <input type="text" value={optionsMap.typeOther} onChange={(e) => setOptionsMap({...optionsMap, typeOther: e.target.value})} className="bg-surface-container-lowest border border-primary/30 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary" placeholder="Type" />
                        </div>
                      )}

                      <div className="flex flex-col gap-1 w-full">
                        <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Expiry</label>
                        <input type="date" value={optionsMap.expiry} onChange={(e) => setOptionsMap({...optionsMap, expiry: e.target.value})} className="bg-surface-container-low border border-white/10 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-primary/50 [color-scheme:dark]" />
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6 bg-surface-container-lowest p-6 rounded-lg border border-white/5">
                    {importType === "options" && renderHeaderDropdown(optionsMap.dateTime, v => setOptionsMap({...optionsMap, dateTime: v}), "DateTime")}
                    {importType === "indicator" && renderHeaderDropdown(indicatorMap.dateTime, v => setIndicatorMap({...indicatorMap, dateTime: v}), "DateTime")}
                    {importType === "spot" && renderHeaderDropdown(spotMap.dateTime, v => setSpotMap({...spotMap, dateTime: v}), "DateTime")}

                    <div className="col-span-1 md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-6">
                       {/* Date Config — FIX: controlled inputs */}
                       <div className="space-y-3 p-4 bg-surface-container border border-white/5 rounded-md">
                          {importType === "options" && renderHeaderDropdown(optionsMap.date, v => setOptionsMap({...optionsMap, date: v}), "Date")}
                          {importType === "indicator" && renderHeaderDropdown(indicatorMap.date, v => setIndicatorMap({...indicatorMap, date: v}), "Date")}
                          {importType === "spot" && renderHeaderDropdown(spotMap.date, v => setSpotMap({...spotMap, date: v}), "Date")}
                          <div className="flex gap-3">
                            <div className="flex-1">
                              <label className="text-[10px] text-slate-500 font-bold uppercase">Start at</label>
                              <input type="number"
                                value={importType==="options" ? optionsMap.dateStart : importType==="indicator" ? indicatorMap.dateStart : spotMap.dateStart}
                                onChange={e => importType==="options" ? setOptionsMap({...optionsMap, dateStart: e.target.value}) : importType==="indicator" ? setIndicatorMap({...indicatorMap, dateStart: e.target.value}) : setSpotMap({...spotMap, dateStart: e.target.value})}
                                className="w-full bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-sm text-white focus:border-primary/50" />
                            </div>
                            <div className="flex-1">
                              <label className="text-[10px] text-slate-500 font-bold uppercase">End at</label>
                              <input type="number"
                                value={importType==="options" ? optionsMap.dateEnd : importType==="indicator" ? indicatorMap.dateEnd : spotMap.dateEnd}
                                onChange={e => importType==="options" ? setOptionsMap({...optionsMap, dateEnd: e.target.value}) : importType==="indicator" ? setIndicatorMap({...indicatorMap, dateEnd: e.target.value}) : setSpotMap({...spotMap, dateEnd: e.target.value})}
                                className="w-full bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-sm text-white focus:border-primary/50" />
                            </div>
                          </div>
                       </div>
                       {/* Time Config — FIX: controlled inputs */}
                       <div className="space-y-3 p-4 bg-surface-container border border-white/5 rounded-md">
                          {importType === "options" && renderHeaderDropdown(optionsMap.time, v => setOptionsMap({...optionsMap, time: v}), "Time")}
                          {importType === "indicator" && renderHeaderDropdown(indicatorMap.time, v => setIndicatorMap({...indicatorMap, time: v}), "Time")}
                          {importType === "spot" && renderHeaderDropdown(spotMap.time, v => setSpotMap({...spotMap, time: v}), "Time")}
                          <div className="flex gap-3">
                            <div className="flex-1">
                              <label className="text-[10px] text-slate-500 font-bold uppercase">Start at</label>
                              <input type="number"
                                value={importType==="options" ? optionsMap.timeStart : importType==="indicator" ? indicatorMap.timeStart : spotMap.timeStart}
                                onChange={e => importType==="options" ? setOptionsMap({...optionsMap, timeStart: e.target.value}) : importType==="indicator" ? setIndicatorMap({...indicatorMap, timeStart: e.target.value}) : setSpotMap({...spotMap, timeStart: e.target.value})}
                                className="w-full bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-sm text-white focus:border-primary/50" />
                            </div>
                            <div className="flex-1">
                              <label className="text-[10px] text-slate-500 font-bold uppercase">End at</label>
                              <input type="number"
                                value={importType==="options" ? optionsMap.timeEnd : importType==="indicator" ? indicatorMap.timeEnd : spotMap.timeEnd}
                                onChange={e => importType==="options" ? setOptionsMap({...optionsMap, timeEnd: e.target.value}) : importType==="indicator" ? setIndicatorMap({...indicatorMap, timeEnd: e.target.value}) : setSpotMap({...spotMap, timeEnd: e.target.value})}
                                className="w-full bg-surface-container-lowest border border-white/10 rounded px-2 py-1 text-sm text-white focus:border-primary/50" />
                            </div>
                          </div>
                       </div>
                    </div>
                  </div>

                  {/* OHLCV Map — options/indicator; Spot only needs Price */}
                  {importType !== "spot" && (
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                      {renderHeaderDropdown(importType === "options" ? optionsMap.open : indicatorMap.open, v => importType==="options" ? setOptionsMap({...optionsMap, open: v}) : setIndicatorMap({...indicatorMap, open: v}), "Open")}
                      {renderHeaderDropdown(importType === "options" ? optionsMap.high : indicatorMap.high, v => importType==="options" ? setOptionsMap({...optionsMap, high: v}) : setIndicatorMap({...indicatorMap, high: v}), "High")}
                      {renderHeaderDropdown(importType === "options" ? optionsMap.low : indicatorMap.low, v => importType==="options" ? setOptionsMap({...optionsMap, low: v}) : setIndicatorMap({...indicatorMap, low: v}), "Low")}
                      {renderHeaderDropdown(importType === "options" ? optionsMap.close : indicatorMap.close, v => importType==="options" ? setOptionsMap({...optionsMap, close: v}) : setIndicatorMap({...indicatorMap, close: v}), "Close")}
                      {renderHeaderDropdown(importType === "options" ? optionsMap.volume : indicatorMap.volume, v => importType==="options" ? setOptionsMap({...optionsMap, volume: v}) : setIndicatorMap({...indicatorMap, volume: v}), "Volume")}
                    </div>
                  )}
                  {/* Spot Data: only needs Price column */}
                  {importType === "spot" && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {renderHeaderDropdown(spotMap.price, v => setSpotMap({...spotMap, price: v}), "Spot Price")}
                    </div>
                  )}

                  {/* Base Setup Map */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-white/5">
                    
                    <div className="flex flex-col gap-1 w-full">
                      <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Exchange</label>
                      <select 
                        value={importType === "options" ? optionsMap.exchange : indicatorMap.exchange} 
                        onChange={(e) => importType === "options" ? setOptionsMap({...optionsMap, exchange: e.target.value}) : setIndicatorMap({...indicatorMap, exchange: e.target.value})}
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
                        onChange={(e) => importType === "options" ? setOptionsMap({...optionsMap, stock: e.target.value}) : setIndicatorMap({...indicatorMap, stock: e.target.value})}
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

                  </div>

                  {/* Indicator Specific Maps */}
                  {importType === "indicator" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-white/5">
                      {renderHeaderDropdown(indicatorMap.buy, (val) => setIndicatorMap({...indicatorMap, buy: val}), "Buy Signal Column")}
                      {renderHeaderDropdown(indicatorMap.sell, (val) => setIndicatorMap({...indicatorMap, sell: val}), "Sell Signal Column")}
                    </div>
                  )}

                  <div className="pt-6">
                    <button type="submit" className="w-full md:w-auto bg-primary text-on-primary px-10 py-4 rounded-lg font-bold uppercase tracking-wide text-sm hover:brightness-110 flex justify-center items-center gap-2 transition-all shadow-[0_0_20px_rgba(78,222,163,0.3)]">
                      <Upload size={18} /> Ingest {importType === 'options' ? 'Options' : importType === 'indicator' ? 'Indicator' : 'Spot/Index'} Data
                    </button>
                  </div>
                </form>
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
              <Settings className="text-primary" size={28}/> Indicator Validator
            </h2>
            <div className="glass-card border border-white/5 p-8 rounded-xl relative overflow-hidden">
               <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-50"></div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-8">
                
                {/* Column 1 */}
                <div className="space-y-6">
                  
                  <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Indicator</label>
                    {/* FIX: Dynamic dropdown populated from /api/indicators — not hardcoded */}
                    <select value={valConfig.indicator} onChange={(e) => setValConfig({...valConfig, indicator: e.target.value})}
                      className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50">
                      {indicatorOptions.length > 0
                        ? indicatorOptions.map(i => <option key={i} value={i}>{i}</option>)
                        : <option value="">No indicators imported yet</option>
                      }
                    </select>
                    {indicatorOptions.length === 0 && <p className="text-[10px] text-amber-400 mt-1">Import indicator data first, then revisit this tab.</p>}
                  </div>

                  <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Start Date</label>
                    <input type="date" value={valConfig.startDate} onChange={(e) => setValConfig({...valConfig, startDate: e.target.value})} className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50 [color-scheme:dark]" />
                  </div>

                  <div className="flex flex-col gap-1 w-full relative">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Script (ATM)</label>
                    <select value={valConfig.script} onChange={(e) => setValConfig({...valConfig, script: e.target.value})}
                      className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50">
                      <option value="ATM">ATM</option>
                      <option value="ATM+">ATM+</option>
                      <option value="ATM-">ATM-</option>
                    </select>
                  </div>

                  {/* NEW: Strike Interval — per spec: 50 for NIFTY, 100 for BANKNIFTY */}
                  <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Strike Interval</label>
                    <select value={valConfig.interval} onChange={(e) => setValConfig({...valConfig, interval: e.target.value})}
                      className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50">
                      <option value="50">50 (NIFTY)</option>
                      <option value="100">100 (BANKNIFTY / Sensex)</option>
                      <option value="25">25 (FinNIFTY)</option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Entry Signal</label>
                    <select 
                      value={valConfig.entrySignal} 
                      onChange={(e) => setValConfig({...valConfig, entrySignal: e.target.value})}
                      className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50"
                    >
                      <option value="Buy">Buy</option>
                      <option value="Sell">Sell</option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Entry Time</label>
                    <select 
                      value={valConfig.entryTime} 
                      onChange={(e) => setValConfig({...valConfig, entryTime: e.target.value})}
                      className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50"
                    >
                      <option value="At Signal">At Signal</option>
                      <option value="Next Candle">Next Candle</option>
                    </select>
                  </div>
                  
                  <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Entry Point</label>
                    <select 
                      value={valConfig.entryPoint} 
                      onChange={(e) => setValConfig({...valConfig, entryPoint: e.target.value})}
                      className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50"
                    >
                      <option value="Open">Open</option>
                      <option value="High">High</option>
                      <option value="Low">Low</option>
                      <option value="Close">Close</option>
                    </select>
                  </div>

                </div>

                {/* Column 2 */}
                <div className="space-y-6 pt-12 md:pt-0">
                  
                  <div className="flex flex-col gap-1 w-full opacity-0 pointer-events-none hidden md:flex">
                     {/* Placeholder to align End Date with Start Date vertically */}
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Hidden</label>
                    <div className="h-[46px]"></div>
                  </div>

                  <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">End Date</label>
                    <input type="date" value={valConfig.endDate} onChange={(e) => setValConfig({...valConfig, endDate: e.target.value})} className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50 [color-scheme:dark]" />
                  </div>

                  <div className="flex flex-col gap-1 w-full">
                    <label className={`text-xs font-bold uppercase tracking-wider ${valConfig.script === "ATM" ? "text-slate-600" : "text-primary"}`}>ATM ± Value</label>
                    <select 
                      value={valConfig.atmOffset} 
                      onChange={(e) => setValConfig({...valConfig, atmOffset: e.target.value})}
                      disabled={valConfig.script === "ATM"}
                      className={`border rounded px-3 py-3 text-sm focus:outline-none transition-all ${valConfig.script === "ATM" ? "bg-surface-container-lowest border-white/5 text-slate-600 cursor-not-allowed" : "bg-surface-container-low border-primary/30 text-white focus:border-primary shadow-[0_0_10px_rgba(78,222,163,0.1)]"}`}
                    >
                      {atmMultiples.map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Exit Signal</label>
                    <select 
                      value={valConfig.exitSignal} 
                      onChange={(e) => setValConfig({...valConfig, exitSignal: e.target.value})}
                      className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50"
                    >
                      <option value="Buy">Buy</option>
                      <option value="Sell">Sell</option>
                    </select>
                  </div>

                  <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Exit Time</label>
                    <select 
                      value={valConfig.exitTime} 
                      onChange={(e) => setValConfig({...valConfig, exitTime: e.target.value})}
                      className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50"
                    >
                      <option value="At Signal">At Signal</option>
                      <option value="Next Candle">Next Candle</option>
                    </select>
                  </div>
                  
                  <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Exit Point</label>
                    <select 
                      value={valConfig.exitPoint} 
                      onChange={(e) => setValConfig({...valConfig, exitPoint: e.target.value})}
                      className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50"
                    >
                      <option value="Open">Open</option>
                      <option value="High">High</option>
                      <option value="Low">Low</option>
                      <option value="Close">Close</option>
                    </select>
                  </div>

                  {/* NEW: Rounding Method — per spec: Closest/Floor/Ceiling */}
                  <div className="flex flex-col gap-1 w-full">
                    <label className="text-xs text-slate-400 font-bold uppercase tracking-wider">Rounding Method</label>
                    <select value={valConfig.roundingMethod} onChange={(e) => setValConfig({...valConfig, roundingMethod: e.target.value})}
                      className="bg-surface-container-low border border-white/10 rounded px-3 py-3 text-sm text-white focus:outline-none focus:border-primary/50">
                      <option value="closest">Closest (Standard)</option>
                      <option value="floor">Floor (Round Down)</option>
                      <option value="ceiling">Ceiling (Round Up)</option>
                    </select>
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
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <h2 className="text-3xl font-headline font-black mb-6 flex items-center gap-3">
              <BarChart2 className="text-primary" size={28}/> Performance Report
            </h2>
            
            {report ? (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="glass-card border border-white/5 p-6 rounded-xl flex flex-col justify-center items-center text-center">
                    <div className="text-slate-400 text-sm font-bold uppercase tracking-wider mb-2">Total P&L</div>
                    <div className={`text-4xl font-black ${report.totalProfit >= 0 ? 'text-primary' : 'text-error'}`}>
                      ${report.totalProfit.toLocaleString()}
                    </div>
                  </div>
                  <div className="glass-card border border-white/5 p-6 rounded-xl flex flex-col justify-center items-center text-center">
                    <div className="text-slate-400 text-sm font-bold uppercase tracking-wider mb-2">Win Rate</div>
                    <div className="text-4xl font-black text-white">{report.winRate}%</div>
                  </div>
                  <div className="glass-card border border-white/5 p-6 rounded-xl flex flex-col justify-center items-center text-center">
                    <div className="text-slate-400 text-sm font-bold uppercase tracking-wider mb-2">Total Trades</div>
                    <div className="text-4xl font-black text-white">{report.totalTrades}</div>
                  </div>
                </div>

                <div className="glass-card border border-white/5 p-6 rounded-xl overflow-hidden relative">
                   <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-50"></div>
                  <h3 className="text-xl font-bold mb-4">Equity Curve</h3>
                  <div className="h-[400px] w-full rounded-lg overflow-hidden bg-surface-container-lowest">
                    <Plot
                      data={[
                        {
                          x: report.trades.map((_: any, i: number) => `Trade ${i+1}`),
                          y: report.trades.reduce((acc: number[], curr: any) => {
                            acc.push((acc.length > 0 ? acc[acc.length - 1] : 0) + curr.profit);
                            return acc;
                          }, []),
                          type: 'scatter',
                          mode: 'lines+markers',
                          marker: {color: '#4edea3'},
                          line: {color: '#4edea3', width: 3},
                          fill: 'tozeroy',
                          fillcolor: 'rgba(78, 222, 163, 0.1)'
                        }
                      ]}
                      layout={{
                        autosize: true,
                        paper_bgcolor: 'transparent',
                        plot_bgcolor: 'transparent',
                        font: { color: '#dae2fd' },
                        margin: { l: 40, r: 20, t: 20, b: 40 },
                        xaxis: { showgrid: false, color: '#45464d' },
                        yaxis: { gridcolor: '#171f33', color: '#45464d' }
                      }}
                      useResizeHandler={true}
                      style={{ width: "100%", height: "100%" }}
                      config={{ displayModeBar: false }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="glass-card border border-white/5 p-12 rounded-xl text-center text-slate-500">
                <BarChart2 size={48} className="mx-auto mb-4 opacity-50" />
                <p>No validation results available. Please run the validator first.</p>
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  );
}
