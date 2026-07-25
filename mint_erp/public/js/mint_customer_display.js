(function () {
  if (!location.pathname.startsWith("/mint") && !location.pathname.startsWith("/banking")) return;

  const customerCache = new Map();
  const pendingIds = new Set();
  const customerIdPattern = /\bCUST-\d{4}-\d{5}\b/g;
  let flushTimer = null;

  function markCustomerMeta(doc) {
    if (doc?.name === "Customer" && doc?.doctype === "DocType") {
      doc.title_field = "customer_name_with_area";
      doc.show_title_field_in_link = 1;
    }
  }

  function setCustomerMetaForMint() {
    const docs = window.frappe?.boot?.docs || [];
    docs.forEach(markCustomerMeta);
  }

  function patchFetchForCustomerMeta() {
    if (!window.fetch || window.__mintErpCustomerFetchPatched) return;

    const originalFetch = window.fetch.bind(window);
    window.__mintErpCustomerFetchPatched = true;

    window.fetch = function () {
      const args = arguments;
      return originalFetch.apply(window, args).then((response) => {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        if (!url.includes("frappe.desk.form.load.getdoctype")) return response;

        const parsedUrl = new URL(url, location.origin);
        if (parsedUrl.searchParams.get("doctype") !== "Customer") return response;

        return response
          .clone()
          .json()
          .then((data) => {
            (data.docs || []).forEach(markCustomerMeta);
            const headers = new Headers(response.headers);
            headers.set("content-type", "application/json");
            return new Response(JSON.stringify(data), {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          })
          .catch(() => response);
      });
    };
  }

  function getCustomerIdFromHref(href) {
    const match = (href || "").match(/\/app\/customer\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function queueCustomer(id) {
    if (!id || customerCache.has(id)) return;
    pendingIds.add(id);
    if (flushTimer) return;
    flushTimer = window.setTimeout(fetchPendingCustomers, 80);
  }

  function fetchPendingCustomers() {
    flushTimer = null;
    const ids = Array.from(pendingIds);
    pendingIds.clear();
    if (!ids.length) return;

    const url = "/api/method/mint_erp.mint_customer_display.get_customer_display_names";
    const params = new URLSearchParams({ customer_ids: JSON.stringify(ids) });

    fetch(`${url}?${params}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then((response) => response.json())
      .then((data) => {
        const names = data.message || {};
        Object.keys(names).forEach((id) => customerCache.set(id, names[id]));
        ids.forEach((id) => {
          if (!customerCache.has(id)) customerCache.set(id, null);
        });
        replaceCustomerLabels();
      })
      .catch(() => {});
  }

  function getLeafText(node) {
    if (!node || node.childNodes.length !== 1) return "";
    return node.textContent.trim();
  }

  function replaceCustomerIdInNode(node, id) {
    const label = customerCache.get(id);
    if (label) {
      node.textContent = label;
      node.title = id;
      return;
    }

    if (!customerCache.has(id)) queueCustomer(id);
  }

  function replaceCustomerIdInAgainstAccountCell(cell) {
    const link = cell.querySelector("a");
    const node = link || cell;
    const id = getLeafText(node);
    if (!id) return;

    const label = customerCache.get(id);
    if (label) {
      node.textContent = label;
      node.title = id;
      cell.title = id;
      if (link) {
        link.href = `/app/customer/${encodeURIComponent(id)}`;
      }
      return;
    }

    if (!customerCache.has(id)) queueCustomer(id);
  }

  function replaceAgainstAccountTableColumns(scope) {
    const tables = new Set();
    if (scope.matches?.("table")) tables.add(scope);
    scope.querySelectorAll?.("table").forEach((table) => tables.add(table));
    const closestTable = scope.closest?.("table");
    if (closestTable) tables.add(closestTable);

    tables.forEach((table) => {
      const headerCells = Array.from(table.querySelectorAll("thead tr:first-child th"));
      const againstIndex = headerCells.findIndex((header) => header.textContent.trim() === "Against Account");

      if (againstIndex >= 0) {
        table.querySelectorAll("tbody tr").forEach((row) => {
          const cells = row.querySelectorAll("td");
          if (cells[againstIndex]) replaceCustomerIdInAgainstAccountCell(cells[againstIndex]);
        });
      }

      table.querySelectorAll("tr").forEach((row) => {
        const cells = row.querySelectorAll("th, td");
        if (cells.length >= 2 && cells[0].textContent.trim() === "Against Account") {
          replaceCustomerIdInAgainstAccountCell(cells[1]);
        }
      });
    });
  }

  function replaceCustomerIdsInTextNodes(scope) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || ["SCRIPT", "STYLE", "TEXTAREA", "INPUT"].includes(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        customerIdPattern.lastIndex = 0;
        return customerIdPattern.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach((node) => {
      customerIdPattern.lastIndex = 0;
      const ids = Array.from(new Set(node.nodeValue.match(customerIdPattern) || []));
      const missingIds = ids.filter((id) => !customerCache.has(id));
      if (missingIds.length) {
        missingIds.forEach(queueCustomer);
        return;
      }

      node.nodeValue = node.nodeValue.replace(customerIdPattern, (id) => customerCache.get(id) || id);
      if (node.parentElement) node.parentElement.title = ids.join(", ");
    });
  }

  function replaceCustomerLabels(root) {
    const scope = root && root.querySelectorAll ? root : document;

    scope.querySelectorAll('a[href*="/app/customer/"]').forEach((link) => {
      const id = getCustomerIdFromHref(link.getAttribute("href"));
      const label = customerCache.get(id);
      if (label && link.textContent.trim() === id) {
        link.textContent = label;
        link.title = id;
      } else {
        queueCustomer(id);
      }
    });

    scope.querySelectorAll("span, button").forEach((node) => {
      const text = node.childNodes.length === 1 ? node.textContent.trim() : "";
      const match = text.match(/^([^()]+)\s+\(Customer\)$/);
      if (!match) return;

      const id = match[1].trim();
      const label = customerCache.get(id);
      if (label) {
        node.textContent = `${label} (Customer)`;
        node.title = id;
      } else {
        queueCustomer(id);
      }
    });

    replaceAgainstAccountTableColumns(scope);
    replaceCustomerIdsInTextNodes(scope);
  }

  setCustomerMetaForMint();
  patchFetchForCustomerMeta();

  window.addEventListener("load", () => replaceCustomerLabels());

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          replaceCustomerLabels(node);
        }
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
