document.documentElement.classList.add("has-js");

(() => {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const nameMark = document.querySelector("[data-name-mark]");
  let rippleTimer = 0;

  initNameMotion();
  initReveal();

  function initNameMotion() {
    if (!nameMark) return;

    const replay = () => {
      if (reducedMotion.matches) return;

      window.clearTimeout(rippleTimer);
      nameMark.classList.remove("is-rippling");

      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          nameMark.classList.add("is-rippling");
          rippleTimer = window.setTimeout(() => {
            nameMark.classList.remove("is-rippling");
          }, 900);
        });
      });
    };

    nameMark.addEventListener("pointerenter", replay, { passive: true });
  }

  function initReveal() {
    const items = document.querySelectorAll(".reveal-item");

    if (reducedMotion.matches || !("IntersectionObserver" in window)) {
      items.forEach((item) => item.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -6%", threshold: 0.08 }
    );

    items.forEach((item) => observer.observe(item));
  }
})();
