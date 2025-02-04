const { S3Client } = require("@aws-sdk/client-s3");
const { CloudFrontClient } = require("@aws-sdk/client-cloudfront");
const { uploadToKeboola } = require("@hlidac-shopu/actors-common/keboola.js");
const {
  toProduct,
  uploadToS3,
  invalidateCDN
} = require("@hlidac-shopu/actors-common/product.js");
const Apify = require("apify");
const { URL, URLSearchParams } = require("url");

/** @typedef { import("apify").CheerioHandlePage } CheerioHandlePage */
/** @typedef { import("apify").CheerioHandlePageInputs } CheerioHandlePageInputs */
/** @typedef { import("apify").RequestQueue } RequestQueue */

const { log } = Apify.utils;

const COUNTRY = {
  CZ: "CZ",
  SK: "SK",
  PL: "PL",
  HU: "HU",
  DE: "DE",
  AT: "AT"
};

const makeListingUrl = (
  countryCode,
  productQuery,
  currentPage,
  pageSize = 100
) =>
  `https://products.dm.de/product/${countryCode.toLowerCase()}/search?${new URLSearchParams(
    {
      productQuery,
      currentPage,
      pageSize,
      purchasableOnly: false,
      hideFacets: false,
      hideSorts: true
    }
  )}`;

const createProductUrl = (country, url) =>
  new URL(url, `https://dm.${country.toLowerCase()}`).href;

function* traverseCategories(categories, names = []) {
  for (const category of categories) {
    if (category.subcategories) {
      yield* traverseCategories(category.subcategories, [
        ...names,
        category.name
      ]);
    } else {
      names = [...names, category.name];
    }
    category.breadcrumbs = names.filter(x => x !== "null").join(" > ");
    yield category;
  }
}

function* paginateResults(category) {
  const length = Math.ceil(category.count / 100);
  for (let i = 1; i <= length; i++) {
    yield i;
  }
}

function s3FileName(detail) {
  const url = new URL(detail.itemUrl);
  return url.pathname.match(/-p(\d+)\.html$/)?.[1];
}

/**
 * Creates Page Function for scraping
 * @param {RequestQueue} requestQueue
 * @param {S3Client} s3
 * @returns {CheerioHandlePage}
 */
function pageFunction(requestQueue, s3) {
  const processedIds = new Set();

  /**
   *  @param {CheerioHandlePageInputs} context
   *  @returns {Promise<void>}
   */
  async function handler(context) {
    const { body, contentType, request, response, json } = context;
    const { country, step, category } = request.userData;
    if (response.statusCode !== 200) {
      return log.info(body.toString(contentType.encoding));
    }

    const { pagination, products, categories } = json;

    if (step === "START") {
      log.info("Pagination info", pagination);
      // we are traversing recursively from leaves to trunk
      for (const category of traverseCategories(categories)) {
        for (const page of paginateResults(category)) {
          // we need to await here to prevent higher categories
          // to be enqueued sooner than sub-categories
          await requestQueue.addRequest({
            url: makeListingUrl(country, category.productQuery, page),
            userData: {
              country,
              category: category.breadcrumbs
            }
          });
        }
      }
    } else {
      // we don't need to block pushes, we will await them all at the end
      const requests = [];
      // push only unique items
      const unprocessedProducts = products.filter(
        p => !processedIds.has(p.gtin)
      );

      for (const item of unprocessedProducts) {
        const detail = parseItem(item);
        requests.push(
          // push data to dataset to be ready for upload to Keboola
          Apify.pushData(detail),
          // upload JSON+LD data to CDN
          uploadToS3(
            s3,
            `dm.${country.toLowerCase()}`,
            s3FileName(detail),
            "jsonld",
            toProduct(detail, {
              brand: item.brandName,
              name: item.name,
              gtin: item.gtin
            })
          )
        );
        processedIds.add(detail.itemId);
      }

      // await all requests, so we don't end before they end
      await Promise.all(requests);

      function parseItem(p) {
        return {
          itemId: p.gtin,
          itemName: `${p.brandName} ${p.name}`,
          itemUrl: createProductUrl(
            country,
            p.links
              .filter(x => x.rel === "self")
              .map(x => x.href)
              .pop()
          ),
          img: p.links
            .filter(x => x.rel.startsWith("productimage"))
            .map(x => x.href)
            .pop(),
          inStock: !p.notAvailable,
          currentPrice: parseFloat(p.price),
          originalPrice: p.isSellout ? parseFloat(p.selloutPrice) : null,
          currency: p.priceCurrencyIso,
          category,
          discounted: p.isSellout
        };
      }
    }
  }
  return handler;
}

function getTableName(country) {
  return `dm_${country.toLowerCase()}`;
}

Apify.main(async () => {
  const s3 = new S3Client({ region: "eu-central-1" });
  const cloudfront = new CloudFrontClient({ region: "eu-central-1" });

  const input = await Apify.getInput();

  const { country = COUNTRY.CZ, productQuery = ":allCategories" } = input ?? {};

  /** @type {RequestQueue} */
  const requestQueue = await Apify.openRequestQueue();
  await requestQueue.addRequest({
    url: makeListingUrl(country, productQuery, 1, 1),
    userData: {
      country,
      productQuery,
      step: "START"
    }
  });

  const proxyConfiguration = await Apify.createProxyConfiguration({
    useApifyProxy: false
  });

  const crawler = new Apify.CheerioCrawler({
    requestQueue,
    proxyConfiguration,
    maxConcurrency: 10,
    additionalMimeTypes: ["application/json", "text/plain"],
    handlePageFunction: pageFunction(requestQueue, s3),
    handleFailedRequestFunction: async ({ request }) => {
      log.error(`Request ${request.url} failed multiple times`, request);
    }
  });

  await crawler.run();
  log.info("crawler finished");

  await invalidateCDN(
    cloudfront,
    "EQYSHWUECAQC9",
    `dm.${country.toLowerCase()}`
  );
  log.info("invalidated Data CDN");

  await uploadToKeboola(getTableName(country));
  log.info("Finished.");
});
