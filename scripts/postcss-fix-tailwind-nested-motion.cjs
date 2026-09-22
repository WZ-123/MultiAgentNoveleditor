'use strict';

/**
 * HeroUI 3.2.4 contains nested pseudo-elements with Tailwind's
 * `motion-reduce:` variant. Tailwind 4 currently lowers those rules into a
 * never-matching `:is()` rule plus a reduced-motion `:not(:is())` rule.
 *
 * Keep this repair deliberately narrow: discard only the impossible rule and
 * unwrap only its matching reduced-motion rule. The production build verifier
 * rejects any empty :is() that survives this pass.
 */
module.exports = function fixTailwindNestedMotion() {
  return {
    postcssPlugin: 'mana-fix-tailwind-nested-motion',
    OnceExit(root) {
      root.walkRules((rule) => {
        if (!rule.selector || !rule.selector.includes(':is()')) return;

        if (rule.selector.includes(':not(:is())')) {
          const parentParams = rule.parent?.type === 'atrule' ? String(rule.parent.params || '') : '';
          if (!/prefers-reduced-motion\s*:\s*reduce/u.test(parentParams)) return;
          rule.selector = rule.selector.replaceAll(':not(:is())', '');
          return;
        }

        rule.remove();
      });
    },
  };
};

module.exports.postcss = true;
