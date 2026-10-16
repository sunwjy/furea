import assert from "node:assert/strict";
import { test } from "node:test";
import { releasePlan } from "./release-plan.mjs";

test("pending changesets mean the release PR is still open: version, do not publish", () => {
  assert.deepEqual(releasePlan({ changesets: ["brave-cats.md"], version: "0.2.0", published: false }), {
    publish: false,
    reason: "1 pending changeset: the release job opens or updates the release PR",
  });
});

test("no changesets and an unpublished version is a merged release PR: publish", () => {
  assert.deepEqual(releasePlan({ changesets: [], version: "0.2.0", published: false }), {
    publish: true,
    reason: "furea@0.2.0 is not on npm yet",
  });
});

test("a version already on npm is an ordinary push after the release: nothing to publish", () => {
  assert.equal(releasePlan({ changesets: [], version: "0.2.0", published: true }).publish, false);
});

test("0.0.0 is never published: the first release is the manual 0.1.0 bootstrap", () => {
  const plan = releasePlan({ changesets: [], version: "0.0.0", published: false });
  assert.equal(plan.publish, false);
  assert.match(plan.reason, /docs\/release\.md/);
});
