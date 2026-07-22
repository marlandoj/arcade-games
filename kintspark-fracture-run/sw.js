const CACHE_PREFIX = "kintspark-fracture-run-";
const CACHE_NAME = "kintspark-fracture-run-v0.1.0";
const SCOPE_URL = new URL(self.registration.scope);
const INDEX_URL = new URL("./index.html", SCOPE_URL);
const MANIFEST_URL = new URL("./manifest.webmanifest", SCOPE_URL);

async function discoverShellUrls() {
	const response = await fetch(INDEX_URL, { cache: "no-store" });
	if (!response.ok)
		throw new Error(`Unable to cache shell: ${response.status}`);
	const html = await response.text();
	const urls = new Set([SCOPE_URL.href, INDEX_URL.href, MANIFEST_URL.href]);
	for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
		const reference = match[1];
		if (!reference || reference.startsWith("#")) continue;
		const url = new URL(reference, INDEX_URL);
		if (
			url.origin === SCOPE_URL.origin &&
			url.href.startsWith(SCOPE_URL.href)
		) {
			urls.add(url.href);
		}
	}
	return [...urls].sort();
}

self.addEventListener("install", (event) => {
	event.waitUntil(
		discoverShellUrls().then(async (urls) => {
			const cache = await caches.open(CACHE_NAME);
			await cache.addAll(urls);
			await self.skipWaiting();
		}),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
						.map((key) => caches.delete(key)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

async function cachedAsset(request) {
	const cached = await caches.match(request);
	if (cached) return cached;
	const response = await fetch(request);
	if (response.ok) {
		const cache = await caches.open(CACHE_NAME);
		await cache.put(request, response.clone());
	}
	return response;
}

async function navigation(request) {
	try {
		const response = await fetch(request);
		if (response.ok) {
			const cache = await caches.open(CACHE_NAME);
			await cache.put(INDEX_URL, response.clone());
		}
		return response;
	} catch {
		return (await caches.match(INDEX_URL)) ?? Response.error();
	}
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	const url = new URL(request.url);
	if (
		request.method !== "GET" ||
		url.origin !== SCOPE_URL.origin ||
		!url.href.startsWith(SCOPE_URL.href)
	) {
		return;
	}
	event.respondWith(
		request.mode === "navigate" ? navigation(request) : cachedAsset(request),
	);
});
