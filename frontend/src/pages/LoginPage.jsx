// file: frontend/src/pages/LoginPage.jsx
import React, { useState, useEffect, useRef } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import LoginForm from '../components/shared/LoginForm';
import AdminSignupForm from '../components/shared/AdminSignupForm';
import * as THREE from 'three';

/*
  Premium styles for the right-side hero, including a hand-drawn style
  spiral arrow rendered as static SVG.
*/
const heroStyles = `
  .spiral-arrow-path {
    /* Static arrow - no animation */
  }
`;

/* ── Three.js warm particle canvas ──────────────────────────────── */
function ParticleBackground() {
  const mountRef = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const w = mount.clientWidth;
    const h = mount.clientHeight;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    // Scene + camera
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 1000);
    camera.position.z = 40;

    // Points — 80 particles
    const count = 80;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 40;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 40;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 4;
    }
    const pointsGeo = new THREE.BufferGeometry();
    pointsGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const pointsMat = new THREE.PointsMaterial({
      color: 0xF97316,
      size: 0.22,
      transparent: true,
      opacity: 0.6,
    });
    const points = new THREE.Points(pointsGeo, pointsMat);

    // Lines — connect pairs where distance < 10
    const linePositions = [];
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        const dx = positions[i * 3]     - positions[j * 3];
        const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 10) {
          linePositions.push(
            positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2],
            positions[j * 3], positions[j * 3 + 1], positions[j * 3 + 2],
          );
        }
      }
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePositions), 3));
    const lineMat = new THREE.LineBasicMaterial({ color: 0xF97316, transparent: true, opacity: 0.08 });
    const lines = new THREE.LineSegments(lineGeo, lineMat);

    // Group
    const group = new THREE.Group();
    group.add(points);
    group.add(lines);
    scene.add(group);

    // Resize handler
    const observer = new ResizeObserver(() => {
      const nw = mount.clientWidth;
      const nh = mount.clientHeight;
      renderer.setSize(nw, nh);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
    });
    observer.observe(mount);

    // Animation loop
    let animId;
    function animate() {
      animId = requestAnimationFrame(animate);
      group.rotation.y += 0.0003;
      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(animId);
      observer.disconnect();
      mount.removeChild(renderer.domElement);
      renderer.dispose();
      pointsGeo.dispose();
      pointsMat.dispose();
      lineGeo.dispose();
      lineMat.dispose();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      className="absolute inset-0 pointer-events-none"
      style={{ mixBlendMode: 'screen', opacity: 0.5 }}
    />
  );
}

function LoginPage() {
  const { user, profile, loading } = useAuth();
  const [view, setView] = useState('login'); // 'login' | 'signup'

  if (!loading && user && profile?.role === 'admin') {
    return <Navigate to="/" replace />;
  }

  return (
    <>
      <style>{heroStyles}</style>

      <div className="h-screen overflow-hidden bg-white text-[#020617] flex">
        <div className="flex flex-1 h-full">
          <div className="grid grid-cols-1 md:grid-cols-2 flex-1 h-full">

            {/* ── Left: Auth ───────────────────────────────────────────── */}
            <div className="flex items-center justify-center px-10 py-8 border-r border-[#E2E8F0] overflow-y-auto">
              <div className="w-full max-w-sm">

                {/* Logo only */}
                <div className="h-16 w-16 rounded-xl bg-white border border-[#E2E8F0] overflow-hidden flex items-center justify-center shadow-[0_10px_30px_rgba(2,6,23,0.10)]">
                  <img
                    src="/utilitarianlabs_logo.jpg"
                    alt="Utilitarian Labs"
                    className="h-12 w-12 object-contain"
                  />
                </div>

                {/* Headline */}
                <div className="mt-7">
                  <p className="text-xs uppercase tracking-[0.34em] text-[#64748B]">
                    Get Started
                  </p>
                  <h1 className="mt-3 text-[32px] leading-[1.08] font-semibold tracking-tight text-[#020617]">
                    Welcome to MeetChamp
                  </h1>
                  <p className="mt-2 text-[13px] leading-6 text-[#475569]">
                    Secure admin access for meeting transcripts, AI summaries, and tone alerts across your organization.
                  </p>
                </div>

                {/* Form card */}
                <div className="mt-7 shine-card rounded-2xl bg-white border border-[#E2E8F0] p-7 shadow-[0_24px_70px_rgba(2,6,23,0.12),0_0_0_1px_rgba(255,255,255,0.9)_inset] animate-slide-up delay-100 transition duration-300 ease-out hover:border-[#F97316] hover:shadow-[0_24px_80px_rgba(249,115,22,0.16)]">
                  {view === 'login' ? (
                    <>
                      <LoginForm />
                      <div className="mt-6 text-center text-xs text-[#64748B]">
                        Need an admin account?{' '}
                        <button
                          type="button"
                          onClick={() => setView('signup')}
                          className="font-semibold text-[#F97316] hover:text-[#EA580C]"
                        >
                          Request access
                        </button>
                      </div>
                    </>
                  ) : (
                    <AdminSignupForm
                      onSuccess={() => setView('login')}
                      onBack={() => setView('login')}
                    />
                  )}
                </div>

              </div>
            </div>

            {/* ── Right: Hero panel ─────────────────────────────────────── */}
            <div className="relative overflow-hidden h-full">

              {/* Static premium gradient background */}
              <div className="absolute inset-0 bg-[linear-gradient(145deg,#FFFFFF_0%,#FFF3E8_35%,#FFE0C2_70%,#FFD4AA_100%)]" />

              {/* Orb 1 — top-left warm bloom */}
              <div className="absolute pointer-events-none" style={{
                top: '-10%', left: '-8%',
                width: '55%', height: '55%',
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(249,115,22,0.22) 0%, transparent 70%)',
                animation: 'glowBloom 7s ease-in-out infinite',
                filter: 'blur(32px)',
              }} />

              {/* Orb 2 — bottom-right peach bloom */}
              <div className="absolute pointer-events-none" style={{
                bottom: '-12%', right: '-10%',
                width: '60%', height: '60%',
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(255,180,80,0.28) 0%, transparent 70%)',
                animation: 'glowBloom 9s ease-in-out infinite 1.5s',
                filter: 'blur(40px)',
              }} />

              {/* Orb 3 — mid accent */}
              <div className="absolute pointer-events-none" style={{
                top: '38%', left: '28%',
                width: '36%', height: '36%',
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(249,115,22,0.10) 0%, transparent 70%)',
                animation: 'orbDrift 11s ease-in-out infinite 3s',
                filter: 'blur(24px)',
              }} />

              {/* Rotating conic shine sweep */}
              <div className="absolute pointer-events-none overflow-hidden" style={{
                inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{
                  width: '160%',
                  height: '160%',
                  background: 'conic-gradient(from 0deg, transparent 0%, rgba(255,255,255,0.12) 8%, transparent 16%, transparent 100%)',
                  animation: 'conicSpin 14s linear infinite',
                  mixBlendMode: 'overlay',
                }} />
              </div>

              {/* Three.js particle canvas */}
              <ParticleBackground />

              {/* Content sits above all effects */}
              <div className="relative z-10 h-full flex flex-col items-center justify-center px-12 py-8">

                {/* Single centered column: headline + subtitle + visuals */}
                <div className="flex flex-col items-center text-center gap-4 w-full max-w-xs">
                  <div>
                    <p className="text-[34px] leading-[1.06] font-semibold text-[#020617]">
                      Enter the future
                      <br />
                      of meetings,
                      <br />
                      today.
                    </p>
                    <p className="mt-3 text-[13px] leading-6 text-[#475569]">
                      Turn every conversation into structured insights with transcripts, summaries, and tone alerts — automatically.
                    </p>
                  </div>

                <div className="flex flex-col items-center gap-0">

                    {/* Meeting video — top, slightly smaller */}
                    <video
                      src="/Video%20call.webm"
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="w-[200px] opacity-95"
                      style={{ mixBlendMode: 'multiply' }}
                    />

                    {/* Spiral arrow pointing downward */}
                    <div className="w-[96px] h-[96px] flex-shrink-0 -mt-2 -mb-2">
                      {/*
                        Vertical spiral arrow:
                        Starts top-centre, curves outward to the right with a loop/curl,
                        then sweeps back inward and exits pointing straight down with an arrowhead.
                        pathLength="1" lets stroke-dashoffset animate as a 0→1 fraction.
                      */}
                      <svg viewBox="0 0 80 100" className="w-full h-full" overflow="visible">
                        <path
                          d="M40 5
                             C 70 10, 72 30, 55 38
                             C 38 46, 30 36, 38 26
                             C 46 16, 58 22, 54 34
                             C 50 46, 38 52, 40 68
                             C 40 78, 40 86, 40 94"
                          fill="none"
                          stroke="#1C1917"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          pathLength="1"
                          className="spiral-arrow-path"
                        />
                        {/* Arrowhead — pointing straight down */}
                        <path
                          d="M34 89 L40 96 L46 89"
                          fill="none"
                          stroke="#1C1917"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          pathLength="1"
                          className="spiral-arrow-path"
                        />
                      </svg>
                    </div>

                    {/* Analytics video — bottom */}
                    <video
                      src="/analytics web matmat.webm"
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="w-[220px] opacity-95"
                      style={{ mixBlendMode: 'multiply' }}
                    />

                </div>
                </div>

              </div>
            </div>
            {/* ── End Right ──────────────────────────────────────────────── */}

          </div>
        </div>
      </div>
    </>
  );
}

export default LoginPage;
