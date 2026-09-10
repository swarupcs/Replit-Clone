import { FeatureError } from "./featureRef.js";

/** What order Features install in. plan.md §11.10.
 *
 *  The spec gives one ordering rule that matters here — `installsAfter`, a
 *  Feature declaring which others must already be present — and one that does
 *  not: `overrideFeatureInstallOrder`, which is a property of a devcontainer
 *  this platform does not build the same way. `installsAfter` is honoured;
 *  ties keep the order the file listed, because a file's own order is the only
 *  intent anybody expressed.
 *
 *  **A cycle is refused rather than broken.** Two Features each declaring they
 *  come after the other is a statement that cannot be satisfied, and picking
 *  one arbitrarily would produce a build that works on this deployment and not
 *  on a real devcontainer — which is worse than not building.
 */

export interface Orderable {
  /** The reference as written, which is what `installsAfter` names. */
  id: string;
  installsAfter?: string[];
}

/** Matches `installsAfter` entries against ids.
 *
 *  Loosely on purpose: `installsAfter` names a Feature without its version
 *  (`ghcr.io/devcontainers/features/common-utils`) while the id in the file
 *  usually carries one (`…/common-utils:2`). Comparing the repository part
 *  only is what the spec's own implementations do, and comparing the whole
 *  string would silently satisfy no dependency at all.
 */
function withoutVersion(id: string): string {
  const at = id.indexOf("@");
  const base = at === -1 ? id : id.slice(0, at);
  const colon = base.lastIndexOf(":");
  const slash = base.lastIndexOf("/");
  return colon > slash ? base.slice(0, colon) : base;
}

export function orderFeatures<T extends Orderable>(features: readonly T[]): T[] {
  const byBase = new Map<string, T>();
  for (const feature of features) byBase.set(withoutVersion(feature.id), feature);

  const ordered: T[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (feature: T, trail: string[]): void => {
    const base = withoutVersion(feature.id);
    if (done.has(base)) return;

    if (visiting.has(base)) {
      throw new FeatureError(
        `These features must each be installed after the other: ${[...trail, feature.id].join(" → ")}`,
      );
    }
    visiting.add(base);

    for (const dependency of feature.installsAfter ?? []) {
      const target = byBase.get(withoutVersion(dependency));
      // A dependency the project did not ask for is not an error: the spec
      // treats installsAfter as ordering among what IS installed, not as a
      // requirement that it be installed.
      if (target) visit(target, [...trail, feature.id]);
    }

    visiting.delete(base);
    done.add(base);
    ordered.push(feature);
  };

  for (const feature of features) visit(feature, []);
  return ordered;
}
