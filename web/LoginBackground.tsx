import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/* Background login: jaringan titik yang terhubung garis (constellation).
   Titik-titik melayang lambat, garis muncul antar titik yang dekat, dan
   bereaksi terhadap gerak mouse. Warna diambil dari design tokens dan
   berubah saat tema terang/gelap dialihkan. Render berhenti saat tab tidak
   terlihat untuk hemat baterai. */
export function LoginBackground() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let hasWebGL = false;
    try {
      const probe = document.createElement('canvas');
      hasWebGL = !!(window.WebGLRenderingContext &&
        (probe.getContext('webgl') || probe.getContext('experimental-webgl')));
    } catch { /* WebGL tidak tersedia: biarkan background CSS statis. */ }
    if (!hasWebGL) return;

    const getVar = (name: string, fallback: string) => {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    };

    const bg = new THREE.Color(getVar('--background', '#f0f9ff'));
    const accent = new THREE.Color(getVar('--accent', '#036998'));

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(bg, 0.0008);

    const camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight || 1, 0.1, 60);
    camera.position.set(0, 0, 22);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(bg);

    const canvas = renderer.domElement;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.display = 'block';
    el.style.position = 'relative';
    el.prepend(canvas);

    const count = 90;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 38;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 30;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 18;
      velocities[i * 3] = (Math.random() - 0.5) * 0.04;
      velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.04;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.03;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('velocity', new THREE.BufferAttribute(velocities, 3));
    const material = new THREE.PointsMaterial({ size: 0.12, color: accent, transparent: true, opacity: 0.7, sizeAttenuation: true });
    const points = new THREE.Points(geometry, material);
    scene.add(points);

    const lineGeo = new THREE.BufferGeometry();
    const lineMat = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.18 });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    scene.add(lines);

    /* Sinkronisasi warna background saat tema berubah (terang <-> gelap). */
    const applyTheme = () => {
      const nextBg = new THREE.Color(getVar('--background', '#f0f9ff'));
      const nextAccent = new THREE.Color(getVar('--accent', '#036998'));
      if (scene.fog) scene.fog.color.set(nextBg);
      renderer.setClearColor(nextBg);
      material.color.set(nextAccent);
      lineMat.color.set(nextAccent);
    };

    const mouse = new THREE.Vector2(-100, -100);
    const onMove = (e: MouseEvent) => {
      mouse.x = (e.clientX / el.clientWidth) * 2 - 1;
      mouse.y = -(e.clientY / el.clientHeight) * 2 + 1;
    };
    const onResize = () => {
      camera.aspect = el.clientWidth / el.clientHeight || 1;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('mousemove', onMove);

    let visible = true;
    document.addEventListener('visibilitychange', () => { visible = !document.hidden; });

    const observer = new MutationObserver(() => applyTheme());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      if (!visible) return;
      const t = performance.now() * 0.001;

      const pos = geometry.attributes.position.array as Float32Array;
      const vel = geometry.attributes.velocity.array as Float32Array;
      for (let i = 0; i < count; i++) {
        pos[i * 3] += vel[i * 3];
        pos[i * 3 + 1] += vel[i * 3 + 1];
        pos[i * 3 + 2] += vel[i * 3 + 2];
        if (Math.abs(pos[i * 3]) > 20) vel[i * 3] *= -1;
        if (Math.abs(pos[i * 3 + 1]) > 16) vel[i * 3 + 1] *= -1;
        if (Math.abs(pos[i * 3 + 2]) > 10) vel[i * 3 + 2] *= -1;
      }
      geometry.attributes.position.needsUpdate = true;

      points.rotation.y = mouse.x * 0.05;
      points.rotation.x = mouse.y * 0.05;

      const segs: number[] = [];
      const threshold = 9;
      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          const dx = pos[i * 3] - pos[j * 3];
          const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
          const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < threshold) {
            segs.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2],
                      pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]);
          }
        }
      }
      lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs), 3));

      renderer.render(scene, camera);
    };
    animate();
    onResize();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousemove', onMove);
      renderer.dispose();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    };
  }, []);

  return <div ref={ref} className="login-bg" style={{ position: 'fixed', inset: 0, zIndex: 0, overflow: 'hidden' }} />;
}
