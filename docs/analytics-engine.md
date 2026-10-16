# Analytics Engine is not enabled on this account

You are here because `npx furea deploy` printed

```
analytics  skip  Analytics Engine is not enabled on this account: https://github.com/sunwjy/furea/blob/main/docs/analytics-engine.md
```

or `npx furea status` reported that the instance has no `CLICKS` binding.

## What this means

furea records click breakdowns (time series, countries, referrer hosts, device classes) in [Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/). Some Cloudflare accounts, Workers Free accounts among them, refuse any Worker upload made through the API that carries an Analytics Engine binding: Cloudflare answers `403` with code `10089` ("You need to enable Analytics Engine"). Visiting the Analytics Engine page in the dashboard does not fix it; it offers only "Create Dataset" and no switch to turn on. This is a Cloudflare-side problem tracked upstream in [cloudflare/workers-sdk#9312](https://github.com/cloudflare/workers-sdk/issues/9312).

Your instance works without it. When the account refuses the binding, `deploy` uploads the Worker once more without it and finishes normally. Redirects, links, campaigns and the exact lifetime totals live in D1 and KV and are unaffected; every click is still counted. Only the breakdowns are missing: the admin surface shows lifetime totals and a hint ("no binding") in place of the charts, and the API's stats endpoints answer `503 analytics_unavailable`. Clicks made while the binding is missing are not recorded in Analytics Engine and cannot be added later, so they never appear in breakdowns.

`status` reports the missing binding as information, not as drift, so it does not make `status` exit non-zero.

## The workaround

What has worked (observed in [furea#34](https://github.com/sunwjy/furea/issues/34) and reported in the upstream issue) is adding an Analytics Engine binding to a Worker once **in the Cloudflare dashboard** and deploying it there. After that, API uploads with the binding are accepted on the account, even once that Worker is deleted.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), open the account the instance lives in and go to **Workers & Pages**.
2. Create any Worker (the "Hello World" template is fine) and deploy it. Do not use your furea instance's Worker for this; `deploy` would overwrite whatever you add to it anyway.
3. In that Worker, open **Settings → Bindings → Add → Analytics Engine**, give the binding any variable name and any dataset name, and deploy the Worker from the dashboard.
4. Optionally delete that Worker again.
5. Run the installer again, with the same `--name` and `--account` you installed with:

   ```sh
   npx furea@latest deploy
   ```

   The upload now carries the `CLICKS` binding, and the `analytics` line no longer says `skip`. Nothing is remembered locally: every `deploy` tries the binding again, so this is all it takes.
6. If you have not set the analytics token yet, do it now so the admin surface can read the breakdowns:

   ```sh
   npx furea analytics-token
   ```

`npx furea status` confirms the binding is present.

If the upload is still refused after the dashboard deploy, check [cloudflare/workers-sdk#9312](https://github.com/cloudflare/workers-sdk/issues/9312) for newer reports, or ask Cloudflare support to enable Analytics Engine on the account. The workaround may change over time; this page is updated when it does, without a new furea release.

## Two separate pieces

Click breakdowns need both of these, and the admin surface's hint names whichever is missing:

| Missing | Cause | Fix |
|---|---|---|
| **Binding** (`CLICKS`) | The account refuses Analytics Engine uploads. | The workaround above, then `npx furea deploy`. |
| **Analytics token** (`ANALYTICS_TOKEN`) | No read-only token was set at install. | `npx furea analytics-token`. |

`analytics-token` stores the token even when the binding is missing, with a warning that breakdowns stay empty until the binding is added. The token survives every later `deploy`.
