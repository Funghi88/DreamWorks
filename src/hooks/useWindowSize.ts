import { useState, useEffect } from "react";

export function useWindowSize() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        setSize({ width: window.innerWidth, height: window.innerHeight });
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return size;
}

/** 用户拖拽窗体边缘缩放期间为 true；用于关掉与尺寸打架的 transition，避免「拖起来发涩、跟手延迟」 */
export function useWindowLiveResize(settleMs = 100) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      setActive(true);
      if (t) clearTimeout(t);
      t = setTimeout(() => setActive(false), settleMs);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (t) clearTimeout(t);
    };
  }, [settleMs]);

  return active;
}
