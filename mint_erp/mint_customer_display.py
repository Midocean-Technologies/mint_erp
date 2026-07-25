import json

import frappe
from frappe.desk.search import search_link as standard_search_link

SCRIPT_TAG = '<script src="/assets/mint_erp/js/mint_customer_display.js?v=customer_name_with_area_banking_1"></script>'


def _is_mint_request():
	referer = frappe.get_request_header("Referer") or ""
	return any(path in referer for path in ("/mint", "/banking"))


def _as_list(value):
	if not value:
		return []
	if isinstance(value, str):
		try:
			parsed = json.loads(value)
			if isinstance(parsed, list):
				return parsed
		except ValueError:
			return [value]
	if isinstance(value, (list, tuple, set)):
		return list(value)
	return [value]


def _customer_name_map(customer_ids):
	customer_ids = [customer_id for customer_id in _as_list(customer_ids) if customer_id]
	if not customer_ids:
		return {}

	rows = frappe.get_all(
		"Customer",
		filters={"name": ["in", customer_ids]},
		fields=["name", "customer_name_with_area"],
		limit=len(customer_ids),
	)
	return {row.name: row.customer_name_with_area or row.name for row in rows}


@frappe.whitelist()
def get_customer_display_names(customer_ids=None):
	return _customer_name_map(customer_ids)


def inject_mint_customer_display_script(response=None, request=None):
	if not response or not request:
		return
	if not any(request.path == path or request.path.startswith(f"{path}/") for path in ("/mint", "/banking")):
		return
	if "text/html" not in (response.content_type or ""):
		return

	html = response.get_data(as_text=True)
	if SCRIPT_TAG in html or "</body>" not in html:
		return

	response.set_data(html.replace("</body>", f"  {SCRIPT_TAG}\n</body>", 1))


@frappe.whitelist()
def search_link(
	doctype,
	txt,
	query=None,
	filters=None,
	page_length=20,
	searchfield=None,
	reference_doctype=None,
	ignore_user_permissions=False,
	link_fieldname=None,
):
	results = standard_search_link(
		doctype=doctype,
		txt=txt,
		query=query,
		filters=filters,
		page_length=page_length,
		searchfield=searchfield,
		reference_doctype=reference_doctype,
		ignore_user_permissions=ignore_user_permissions,
		link_fieldname=link_fieldname,
	)

	if doctype != "Customer" or not _is_mint_request():
		return results

	customer_names = _customer_name_map([row.get("value") for row in results])
	for row in results:
		customer_name = customer_names.get(row.get("value"))
		if customer_name:
			row["label"] = customer_name
			row["description"] = row.get("description") or row.get("value")

	return results
