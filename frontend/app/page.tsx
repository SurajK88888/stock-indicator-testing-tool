"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import Link from "next/link";
import { Terminal, Activity, ArrowRight, BarChart2, Zap, Shield, Database, Layout } from "lucide-react";

export default function LandingPage() {
  const [mounted, setMounted] = useState(false);
  const heroRef = useRef(null);
  const cardsRef = useRef(null);
  const floatingIconsRef = useRef(null);

  useEffect(() => {
    setMounted(true);
    // Hero Animation
    gsap.fromTo(
      ".hero-element",
      { y: 50, opacity: 0 },
      { y: 0, opacity: 1, duration: 1, stagger: 0.2, ease: "power3.out" }
    );

    // Floating Icons Animation
    if (floatingIconsRef.current) {
      const icons = (floatingIconsRef.current as HTMLElement).children;
      gsap.to(icons, {
        y: "random(-20, 20)",
        x: "random(-20, 20)",
        rotation: "random(-15, 15)",
        duration: "random(2, 4)",
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
        stagger: 0.1,
      });
    }

    // Cards Animation
    gsap.fromTo(
      ".feature-card",
      { y: 50, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.8, stagger: 0.1, ease: "power2.out", delay: 0.5 }
    );
  }, []);

  const icons = [
    Activity, Terminal, Database, BarChart2, Zap, Shield, Layout,
    Activity, Terminal, Database, BarChart2, Zap, Shield, Layout,
    Activity, Terminal, Database, BarChart2, Zap, Shield, Layout
  ];

  return (
    <div className="bg-background selection:bg-primary/30 min-h-screen flex flex-col">
      {/* Floating Background Icons */}
      <div className="bg-pattern" ref={floatingIconsRef}>
        {mounted && icons.map((Icon, idx) => (
          <div
            key={idx}
            className="floating-icon absolute opacity-5"
            style={{
              top: `${Math.random() * 100}%`,
              left: `${Math.random() * 100}%`,
            }}
          >
            <Icon size={24} />
          </div>
        ))}
      </div>

      {/* TopAppBar Navigation */}
      <nav className="sticky top-0 z-50 bg-[#060e20] flex justify-between items-center w-full px-6 py-4 shadow-2xl">
        <div className="flex items-center gap-3">
          <Terminal className="text-primary" size={24} />
          <span className="text-primary font-black tracking-tighter text-xl brand-font">SOVEREIGN LEDGER</span>
        </div>
        <div className="hidden md:flex items-center gap-8">
          <Link href="/dashboard" className="text-slate-400 hover:text-primary transition-colors font-label text-[0.75rem] uppercase tracking-widest font-medium">Dashboard</Link>
          <a href="#" className="text-slate-400 hover:text-primary transition-colors font-label text-[0.75rem] uppercase tracking-widest font-medium">Strategy</a>
          <a href="#" className="text-slate-400 hover:text-primary transition-colors font-label text-[0.75rem] uppercase tracking-widest font-medium">Monitor</a>
        </div>
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 rounded-full bg-surface-container-high border border-outline/20 flex items-center justify-center overflow-hidden cursor-pointer active:opacity-80">
            <span className="material-symbols-outlined text-sm">person</span>
          </div>
        </div>
      </nav>

      <main className="relative z-10 flex-grow">
        {/* Hero Section */}
        <section ref={heroRef} className="min-h-[707px] flex flex-col justify-center items-center text-center px-6 pt-20 pb-32 overflow-hidden">
          <div className="hero-element inline-flex items-center gap-2 bg-surface-container-lowest/50 border border-primary/10 px-4 py-1.5 rounded-full mb-8">
            <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse"></span>
            <span className="text-[0.65rem] font-bold tracking-[0.2em] text-primary uppercase">v4.2.0 Engine Live</span>
          </div>
          
          <h1 className="hero-element text-5xl md:text-8xl font-black text-on-surface tracking-tighter mb-6 leading-tight max-w-5xl">
            INSTITUTIONAL-GRADE <span className="text-primary">BACKTESTING</span>
          </h1>
          
          <p className="hero-element text-slate-400 text-lg md:text-xl max-w-2xl mb-12 font-light leading-relaxed">
            Execute high-frequency strategies with sub-millisecond precision. The industry-standard ledger for sovereign-grade financial engineering and multi-asset optimization.
          </p>
          
          <div className="hero-element flex flex-col sm:flex-row items-center gap-6">
            <Link href="/dashboard" className="bg-primary text-on-primary px-10 py-4 font-bold tracking-tighter uppercase text-sm hover:brightness-110 transition-all shadow-[0_0_40px_rgba(78,222,163,0.2)]">
              LAUNCH TERMINAL
            </Link>
            <a href="#" className="text-on-surface-variant hover:text-primary transition-colors flex items-center gap-2 font-semibold tracking-tight text-sm">
              DOCUMENTATION 
              <ArrowRight size={16} />
            </a>
          </div>
        </section>

        {/* Featured Section: Bento Grid Performance */}
        <section className="px-6 lg:px-24 py-24 bg-surface-container-lowest" ref={cardsRef}>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 max-w-7xl mx-auto">
            <div className="feature-card lg:col-span-8 glass-card border border-white/5 p-1 rounded-lg overflow-hidden group">
              <div className="aspect-video w-full relative bg-surface-container-high/50 flex items-center justify-center">
                <div className="text-primary text-xl font-bold opacity-50">Terminal UI Preview</div>
                <div className="absolute inset-0 bg-gradient-to-t from-surface-container-lowest via-transparent to-transparent"></div>
              </div>
            </div>
            
            <div className="lg:col-span-4 flex flex-col gap-6">
              <div className="feature-card flex-1 glass-card border border-white/5 p-8 flex flex-col justify-center">
                <div className="text-primary text-5xl font-black mb-2 tracking-tighter">10M+</div>
                <div className="text-on-surface-variant font-label text-xs uppercase tracking-widest">Daily Data Points</div>
              </div>
              <div className="feature-card flex-1 glass-card border border-white/5 p-8 flex flex-col justify-center">
                <div className="text-primary text-5xl font-black mb-2 tracking-tighter">&lt;1ms</div>
                <div className="text-on-surface-variant font-label text-xs uppercase tracking-widest">Execution Latency</div>
              </div>
              <div className="feature-card flex-1 glass-card border border-white/5 p-8 flex flex-col justify-center">
                <div className="text-primary text-5xl font-black mb-2 tracking-tighter">99.9%</div>
                <div className="text-on-surface-variant font-label text-xs uppercase tracking-widest">Uptime Reliability</div>
              </div>
            </div>
          </div>
        </section>

      </main>

      {/* Footer */}
      <footer className="bg-[#060e20] border-t border-white/5 mt-auto relative z-20">
        <div className="w-full px-12 py-16 flex flex-col items-center gap-8 lg:flex-row lg:justify-between">
          <div className="flex flex-col items-center lg:items-start gap-4">
            <div className="flex items-center gap-2">
              <Terminal className="text-primary" size={20} />
              <span className="text-primary font-black tracking-tighter text-lg brand-font uppercase">SOVEREIGN LEDGER</span>
            </div>
            <p className="font-['Inter'] text-[0.7rem] uppercase tracking-[0.2em] font-medium text-slate-500 text-center lg:text-left">
              © 2026 SOVEREIGN LEDGER. INSTITUTIONAL GRADE BACKTESTING ENGINE.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
