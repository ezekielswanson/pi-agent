#!/usr/bin/env python3
"""Build scope and operation registers from official HubSpot docs.

Retrieval is public documentation only. This script does not call HubSpot
account APIs and does not log credentials.
"""

from __future__ import annotations

import hashlib
import json
import re
import ssl
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTERS = ROOT / "registers"
CACHE = Path("/tmp/hs-docs/page-cache")
SCOPES_HTML = Path("/tmp/hs-docs/scopes.html")
RETRIEVED = "2026-10-12"
API_VERSION = "2026-09"
SCOPES_URL = "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes"
INDEX_URL = "https://developers.hubspot.com/docs/_llms/apis/2026-09.txt"
VERSIONING_URL = "https://developers.hubspot.com/docs/developer-tooling/platform/versioning"
DOCS_INDEX = "https://developers.hubspot.com/docs/llms.txt"

NO_API = {
    "cms.knowledge_base.articles.write",
    "cms.knowledge_base.articles.publish",
    "cms.knowledge_base.settings.read",
    "cms.knowledge_base.settings.write",
    "ctas.read",
}
DEPRECATED = {"accounting", "actions", "e-commerce", "integration-sync", "social"}
EXCLUDED_SCOPES = {
    "files.delete": "Mandatory exclusion. File deletion stays unavailable in every tool path.",
    "commerce.payment_links.delete": "Mandatory exclusion. Payment-link deletion stays unavailable in every tool path.",
    "business_units_view.read": "Mandatory exclusion. This scope is not requested and has no tool.",
}
BETA_CANDIDATES = {
    "marketing.aeo.read": "2027-03-beta marketing-aeo spec is listed on the docs index and is not a production API.",
    "marketing.lead_scoring.read": "2027-03-beta marketing-lead-scoring spec is listed on the docs index and is not a production API.",
    "marketing.lead_scoring.write": "2027-03-beta marketing-lead-scoring spec is listed on the docs index and is not a production API.",
    "revenue.contracts.read": "2027-03-beta commerce-contracts spec is listed on the docs index and is not a production API.",
    "revenue.contracts.write": "2027-03-beta commerce-contracts spec is listed on the docs index and is not a production API.",
    "crm.auto.associations.settings.public.api.read": "2027-03-beta crm-activity-auto-associations spec is listed on the docs index. No non-beta required-scope match was assumed.",
    "crm.auto.associations.settings.public.api.write": "2027-03-beta crm-activity-auto-associations spec is listed on the docs index. No non-beta required-scope match was assumed.",
    "reporting.full.admin": "2027-03-beta analytics-reporting spec is listed on the docs index and is not a production API.",
    "reporting.full.edit": "2027-03-beta analytics-reporting spec is listed on the docs index and is not a production API.",
    "reporting.full.read": "2027-03-beta analytics-reporting spec is listed on the docs index and is not a production API.",
    "reporting.full.write": "2027-03-beta analytics-reporting spec is listed on the docs index and is not a production API.",
}
LEGACY_MAP = {
    "files": ["files.read", "files.write"],
    "hubdb": ["hubdb.tables.read", "hubdb.tables.write", "hubdb.rows.read", "hubdb.rows.write"],
    "tickets": ["crm.objects.tickets.read", "crm.objects.tickets.write"],
    "tickets.sensitive": ["crm.objects.tickets.sensitive.read", "crm.objects.tickets.sensitive.write"],
    "tickets.highly_sensitive": [
        "crm.objects.tickets.highly_sensitive.read",
        "crm.objects.tickets.highly_sensitive.write",
    ],
    "timeline": ["timeline.read"],
}

CTX = ssl.create_default_context()


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "pi-agent-scope-audit/1.0"})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=45, context=CTX) as response:
                return response.read().decode("utf-8", "replace")
        except Exception as error:  # noqa: BLE001 - retry transient doc fetches
            last = error
            time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def cached(url: str) -> str:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / hashlib.sha256(url.encode()).hexdigest()
    if path.exists() and path.stat().st_size > 0:
        return path.read_text(errors="replace")
    text = fetch(url)
    path.write_text(text)
    return text


def parse_catalog(html: str) -> list[dict]:
    for scope in NO_API | DEPRECATED | {"files.delete", "business_units_view.read"}:
        if scope not in html:
            raise SystemExit(f"scopes page HTML is missing expected scope {scope}")
    start = html.find("account-info.security.read")
    if start < 0:
        raise SystemExit("scopes table was not found in the HTML")
    tbody = html.rfind("_components.tbody", 0, start)
    note = html.find("corresponding API available", start)
    if tbody < 0 or note < 0:
        raise SystemExit("could not bound the scopes table")
    region = html[tbody:note]
    rows = region.split("_components.tr,{children:")[1:]
    catalog = []
    seen = set()
    for row in rows:
        codes = re.findall(r"_components\.code,\{children:`([^`]+)`\}", row)
        if not codes:
            continue
        scope = codes[0]
        if scope in seen:
            continue
        seen.add(scope)
        first_td = row.split("_components.td,{children:")[1] if "_components.td,{children:" in row else row
        legacy = "Legacy" in first_td[:400]
        texts = re.findall(r"`([^`]*)`", row)
        bits = [
            bit
            for bit in texts
            if bit != scope and not bit.startswith("/") and not bit.startswith("http") and bit not in {"br", "Legacy"}
        ]
        description = re.sub(r"\s+", " ", "".join(bits)).strip()
        availability = ""
        match = re.search(r"Available to .{0,240}", description)
        if match:
            availability = match.group(0).strip()
        links = ["https://developers.hubspot.com" + href if href.startswith("/") else href for href in re.findall(r"href:`([^`]+)`", row)]
        catalog.append(
            {
                "scope": scope,
                "description": description,
                "availability": availability,
                "legacy": legacy,
                "links": links,
                "sourceUrl": SCOPES_URL,
            }
        )
    if len(catalog) < 100:
        raise SystemExit(f"scopes table parse looks truncated: {len(catalog)} rows")
    return catalog


def collect_pages() -> tuple[list[str], list[str]]:
    seen_indexes = set()
    pages = []
    failures = []

    def walk(url: str) -> None:
        if url in seen_indexes:
            return
        seen_indexes.add(url)
        try:
            text = cached(url)
        except Exception as error:  # noqa: BLE001
            failures.append(f"{url}: {error}")
            return
        for link in re.findall(r"\((https://[^)\s]+)\)", text):
            if "2027-03-beta" in link:
                continue
            if link.endswith(".txt"):
                walk(link)
            elif link.endswith(".md"):
                pages.append(link)

    walk(INDEX_URL)
    unique = []
    seen = set()
    for page in pages:
        if page not in seen:
            seen.add(page)
            unique.append(page)
    return unique, failures


def scope_groups(text: str) -> list[dict]:
    groups = []
    for match in re.finditer(r"<ScopesList\b(.*?)</ScopesList>|<ScopesList\b(.*?)\/>", text, re.S):
        block = match.group(0)
        body = re.search(r"scopes=\{\[(.*?)\]", block, re.S)
        if not body:
            continue
        scopes = re.findall(r"""['"]([A-Za-z0-9_.:-]+)['"]""", body.group(1))
        description = ""
        described = re.search(r'description="([^"]*)"', block)
        if described:
            description = described.group(1)
        else:
            description = "This API requires one of the following scopes:"
        mode = "all" if "all of the following" in description.lower() else "any"
        if scopes:
            groups.append({"mode": mode, "scopes": scopes, "description": description})
    return groups


def classify(method: str, path: str, title: str, description: str) -> str:
    blob = f"{title} {description} {path}".lower()
    restorable = any(word in blob for word in ("restor", "recycling bin", "archive"))
    if method == "DELETE" and not restorable and any(word in blob for word in ("permanent", "gdpr", "purge")):
        return "permanent_delete"
    if "unenroll" in blob:
        return "unenroll"
    if "unpublish" in blob:
        return "unpublish"
    if "/associations/" in path and method == "DELETE":
        return "association_remove"
    if "billing" in path:
        return "billing"
    if method == "DELETE" and "/users" in path and "settings" in path:
        return "user_remove"
    if method == "DELETE" and "pipeline" in path:
        return "pipeline_delete"
    if method == "DELETE" and ("/properties" in path or "/schemas" in path):
        return "schema_delete"
    if "/import" in path:
        return "import"
    if method in {"POST", "PUT", "PATCH"} and ("/merge" in path or title.lower().startswith("merge")):
        return "merge"
    if method in {"POST", "PUT", "PATCH"} and ("/publish" in path or title.lower().startswith("publish")):
        return "publish"
    if method in {"POST", "PUT", "PATCH"} and (title.lower().startswith("send") or "/send" in path):
        return "send"
    if method == "DELETE":
        return "archive"
    return "none"


def effect_for(method: str, path: str, title: str) -> str:
    lowered = f"{path} {title}".lower()
    if method == "GET":
        return "read"
    if method == "POST" and (path.endswith("/search") or "/batch/read" in path or "search" in title.lower()):
        return "read"
    if method == "POST" and any(word in lowered for word in ("get ", "retrieve", "read ")):
        if not any(word in lowered for word in ("create", "update", "delete", "archive", "send", "publish", "enroll")):
            return "read"
    return "mutate"


def exclusion_for(method: str, path: str, title: str, groups: list[dict]) -> str | None:
    lowered = path.lower()
    deletes = method == "DELETE" or any(part in lowered for part in ("/gdpr-delete", "/purge", "/permanent"))
    payment = "payment-link" in lowered or "payment_link" in lowered
    file_path = lowered.startswith("/files") or "/files/" in lowered or "/file-manager/" in lowered
    if payment and deletes:
        return EXCLUDED_SCOPES["commerce.payment_links.delete"]
    if file_path and deletes:
        return EXCLUDED_SCOPES["files.delete"]
    if re.search(r"delete a file", title, re.I):
        return EXCLUDED_SCOPES["files.delete"]
    required = [scope for group in groups for scope in group["scopes"]]
    if required and set(required) <= set(EXCLUDED_SCOPES):
        return EXCLUDED_SCOPES[required[0]]
    if groups and all(group["scopes"] == ["files.delete"] or set(group["scopes"]) <= {"files.delete"} for group in groups):
        return EXCLUDED_SCOPES["files.delete"]
    if any(group["mode"] == "all" and "files.delete" in group["scopes"] for group in groups):
        return EXCLUDED_SCOPES["files.delete"]
    if any(group["mode"] == "all" and "commerce.payment_links.delete" in group["scopes"] for group in groups):
        return EXCLUDED_SCOPES["commerce.payment_links.delete"]
    if any("business_units_view.read" in group["scopes"] and group["scopes"] == ["business_units_view.read"] for group in groups):
        return EXCLUDED_SCOPES["business_units_view.read"]
    return None


def operation_id(method: str, path: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", f"{method}-{path}".lower()).strip("-")
    return slug[:180]


def parse_page(url: str, text: str) -> dict | None:
    header = re.search(r"```+yaml specs/(\S+) (GET|POST|PUT|PATCH|DELETE) (\S+)", text)
    if not header:
        return None
    spec, method, path = header.groups()
    if "2027-03-beta" in spec or "2027-03-beta" in path:
        return None
    title = ""
    titled = re.search(r"^# (.+)$", text, re.M)
    if titled:
        title = titled.group(1).strip()
    summary = ""
    title_at = text.find("\n# ")
    summary_source = text[title_at:] if title_at >= 0 else text
    for summarized in re.findall(r"^> (.+)$", summary_source, re.M):
        if "Documentation Index" in summarized or summarized.startswith("Fetch the complete") or summarized.startswith("Use this file"):
            continue
        summary = summarized.strip()
        break
    groups = scope_groups(text)
    version = API_VERSION if API_VERSION in spec or f"/{API_VERSION}/" in path else "unversioned"
    if version != API_VERSION and "/legacy/" in url:
        version = "legacy"
    domain = path.strip("/").split("/")[0] or "other"
    destructive = classify(method, path, title, summary)
    effect = effect_for(method, path, title)
    if destructive != "none":
        effect = "mutate"
    reason = exclusion_for(method, path, title, groups)
    tool = None
    if not reason:
        tool = f"hubspot_{domain}_read" if effect == "read" else "hubspot_prepare_change"
    return {
        "id": operation_id(method, path),
        "title": title,
        "summary": summary,
        "domain": domain,
        "method": method,
        "path": path,
        "spec": spec,
        "version": version,
        "scopeGroups": groups,
        "effect": effect,
        "destructive": destructive,
        "paginated": "paging" in text or "\nafter:" in text or "cursor" in summary.lower(),
        "batch": "/batch/" in path,
        "excluded": bool(reason),
        "exclusionReason": reason,
        "tool": tool,
        "sourceUrl": url,
        "retrievedAt": RETRIEVED,
        "implemented": not reason and bool(groups) and version == API_VERSION,
        "tested": "mock_not_run",
    }


def coverage(ops: list[dict], scope: str) -> dict:
    related = []
    for op in ops:
        names = [name for group in op["scopeGroups"] for name in group["scopes"]]
        if scope in names and not op["excluded"]:
            related.append(op)
    kinds = {op["destructive"] if op["effect"] == "mutate" else "read" for op in related}
    methods = {op["method"] for op in related}
    return {
        "read": "read" in kinds or "GET" in methods and any(op["effect"] == "read" for op in related),
        "create": any(op["method"] == "POST" and op["effect"] == "mutate" and op["destructive"] == "none" for op in related),
        "update": any(op["method"] in {"PATCH", "PUT"} for op in related),
        "archive": any(op["destructive"] == "archive" for op in related),
        "permanentDelete": any(op["destructive"] == "permanent_delete" for op in related),
        "otherDestructive": sorted({op["destructive"] for op in related if op["destructive"] not in {"none", "archive", "permanent_delete"}}),
        "operationIds": [op["id"] for op in related[:40]],
        "operationCount": len(related),
    }


def destructive_counterpart(ops: list[dict], scope: str, description: str) -> dict:
    resource = scope.split(".")[0]
    candidates = []
    for op in ops:
        if op["effect"] != "mutate" or op["destructive"] == "none":
            continue
        names = [name for group in op["scopeGroups"] for name in group["scopes"]]
        if scope in names or any(name.startswith(scope.rsplit(".", 1)[0]) for name in names):
            if resource in op["path"] or scope.split(".")[1:2] == op["path"].strip("/").split("/")[:1]:
                candidates.append(op)
    writes = [op for op in candidates if not op["excluded"]]
    if not writes:
        writes = [op for op in ops if scope in [name for group in op["scopeGroups"] for name in group["scopes"]] and op["destructive"] != "none"]
    if not writes:
        if any(word in description.lower() for word in ("delete", "archive")):
            return {"status": "described_by_scope_text_only", "operation": None, "requiredScopes": [scope], "covered": "described on the scope, endpoint not separately verified"}
        return {"status": "not_applicable_or_unsupported", "operation": None, "requiredScopes": [], "covered": "no verified destructive counterpart"}
    chosen = sorted(writes, key=lambda op: (op["excluded"], op["destructive"] != "archive", op["path"]))[0]
    required = [name for group in chosen["scopeGroups"] for name in group["scopes"]]
    covered = "newly needed" if scope not in required else "covered by this scope"
    if chosen["excluded"]:
        covered = "excluded by policy"
    return {
        "status": chosen["destructive"],
        "operation": {"id": chosen["id"], "method": chosen["method"], "path": chosen["path"], "sourceUrl": chosen["sourceUrl"]},
        "requiredScopes": required,
        "scopeMode": chosen["scopeGroups"][0]["mode"] if chosen["scopeGroups"] else "unknown",
        "covered": covered,
    }


def main() -> None:
    html = SCOPES_HTML.read_text(errors="replace") if SCOPES_HTML.exists() else fetch(SCOPES_URL)
    catalog = parse_catalog(html)
    pages, index_failures = collect_pages()
    print(f"catalog {len(catalog)} pages {len(pages)}", flush=True)
    operations = []
    page_failures = list(index_failures)

    def load(url: str) -> tuple[str, dict | None, str | None]:
        try:
            parsed = parse_page(url, cached(url))
            return url, parsed, None
        except Exception as error:  # noqa: BLE001
            return url, None, str(error)

    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(load, url) for url in pages]
        done = 0
        for future in as_completed(futures):
            url, parsed, error = future.result()
            done += 1
            if error:
                page_failures.append(f"{url}: {error}")
            elif parsed:
                operations.append(parsed)
            if done % 200 == 0:
                print(f"fetched {done}/{len(pages)} operations {len(operations)}", flush=True)

    dedup: dict[tuple[str, str], dict] = {}
    conflicts = []
    for op in operations:
        if op["version"] not in {API_VERSION, "unversioned"}:
            continue
        key = (op["method"], op["path"])
        current = dedup.get(key)
        if current is None:
            dedup[key] = op
            continue
        left = json.dumps(current["scopeGroups"], sort_keys=True)
        right = json.dumps(op["scopeGroups"], sort_keys=True)
        if left != right:
            conflicts.append({"method": op["method"], "path": op["path"], "sources": [current["sourceUrl"], op["sourceUrl"]]})
            current["implemented"] = False
            current["scopeConflict"] = True
        else:
            current.setdefault("alsoSeenAt", []).append(op["sourceUrl"])
    ops = sorted(dedup.values(), key=lambda op: (op["domain"], op["path"], op["method"]))
    for op in ops:
        if op.get("scopeConflict"):
            op["tool"] = None

    catalog_names = {row["scope"] for row in catalog}
    endpoint_scopes = sorted({scope for op in ops for group in op["scopeGroups"] for scope in group["scopes"]})
    baseline = [line.strip() for line in (REGISTERS / "baseline-scopes.txt").read_text().splitlines() if line.strip()]

    scope_rows = []
    for row in catalog:
        scope = row["scope"]
        if scope in EXCLUDED_SCOPES:
            status = "excluded"
        elif scope in NO_API:
            status = "no_api"
        elif scope in DEPRECATED:
            status = "deprecated"
        elif row["legacy"]:
            status = "legacy"
        elif scope in BETA_CANDIDATES:
            status = "beta"
        else:
            status = "current"
        info = coverage(ops, scope)
        scope_rows.append(
            {
                "originalName": scope,
                "canonicalName": scope,
                "status": status,
                "products": row["availability"],
                "description": row["description"],
                "appAccess": "public app OAuth; private apps are not this integration",
                "coverage": info,
                "companionScopes": "See each operation scopeGroups for AND/OR. A scope string is not itself a delete suffix.",
                "sourceUrl": SCOPES_URL,
                "docLinks": row["links"],
                "retrievedAt": RETRIEVED,
                "apiVersion": API_VERSION,
                "requested": False,
                "granted": "not_granted",
                "implementedTools": [],
                "tested": "not_runtime_tested",
                "exclusionReason": EXCLUDED_SCOPES.get(scope),
                "discrepancy": None,
            }
        )

    known = {row["canonicalName"] for row in scope_rows}
    for scope in endpoint_scopes:
        if scope in known or scope in EXCLUDED_SCOPES:
            continue
        info = coverage(ops, scope)
        scope_rows.append(
            {
                "originalName": scope,
                "canonicalName": scope,
                "status": "endpoint_only",
                "products": "Not in the scopes-page table parsed on this retrieval. Required by at least one 2026-09 endpoint page.",
                "description": "Discovered in an endpoint Required Scopes section, missing from the main catalog table.",
                "appAccess": "unverified against the app installer",
                "coverage": info,
                "companionScopes": "See operation scopeGroups.",
                "sourceUrl": next(op["sourceUrl"] for op in ops if any(scope in group["scopes"] for group in op["scopeGroups"])),
                "docLinks": [],
                "retrievedAt": RETRIEVED,
                "apiVersion": API_VERSION,
                "requested": False,
                "granted": "not_granted",
                "implementedTools": [],
                "tested": "not_runtime_tested",
                "exclusionReason": None,
                "discrepancy": "catalog_missing",
            }
        )
        known.add(scope)

    by_name = {row["canonicalName"]: row for row in scope_rows}
    for original, targets in LEGACY_MAP.items():
        if original in by_name:
            by_name[original]["canonicalName"] = targets[0]
            by_name[original]["companionScopes"] = "Legacy scope. Granular replacements named by the scopes page: " + ", ".join(targets)

    if "crm.objects.feedback_submissions.read" not in by_name and "crm.objects.feedback_submission.read" in by_name:
        pass

    def row_for_baseline(scope: str) -> dict:
        if scope == "automation.sequences.write":
            return {
                "originalName": scope,
                "canonicalName": "automation.sequences.create | automation.sequences.edit | automation.sequences.delete",
                "status": "corrected",
                "products": "Sales Hub or Service Hub Professional or Enterprise, per the sequences endpoints.",
                "description": "The baseline name is not a scopes-page row. 2026-09 sequence endpoints require automation.sequences.create, automation.sequences.edit, or automation.sequences.delete for the matching mutation. They are alternatives, not a joint requirement. automation.sequences.read remains the read scope.",
                "coverage": coverage(ops, "automation.sequences.edit"),
                "sourceUrl": "https://developers.hubspot.com/docs/api-reference/latest/automation/sequences/delete-sequence.md",
                "exclusionReason": None,
                "discrepancy": "baseline_name_corrected",
            }
        if scope in by_name:
            return by_name[scope]
        singular = scope.replace("feedback_submissions", "feedback_submission")
        if singular in by_name:
            mapped = dict(by_name[singular])
            mapped["originalName"] = scope
            mapped["discrepancy"] = "baseline_name_corrected"
            return mapped
        if scope in BETA_CANDIDATES:
            return {
                "originalName": scope,
                "canonicalName": scope,
                "status": "beta",
                "products": BETA_CANDIDATES[scope],
                "description": BETA_CANDIDATES[scope],
                "coverage": coverage(ops, scope),
                "sourceUrl": DOCS_INDEX,
                "exclusionReason": None,
                "discrepancy": "beta_candidate",
            }
        if scope in EXCLUDED_SCOPES:
            return {
                "originalName": scope,
                "canonicalName": scope,
                "status": "excluded",
                "products": "Excluded before install. Not requested even when an endpoint would otherwise allow it.",
                "description": EXCLUDED_SCOPES[scope],
                "coverage": coverage(ops, scope),
                "sourceUrl": SCOPES_URL,
                "exclusionReason": EXCLUDED_SCOPES[scope],
                "discrepancy": None,
            }
        return {
            "originalName": scope,
            "canonicalName": scope,
            "status": "unverified",
            "products": "Not present in the parsed scopes table or in 2026-09 Required Scopes sections.",
            "description": "Baseline entry preserved. No production endpoint requirement was verified.",
            "coverage": coverage(ops, scope),
            "sourceUrl": SCOPES_URL,
            "exclusionReason": EXCLUDED_SCOPES.get(scope),
            "discrepancy": "baseline_not_in_catalog",
        }

    matrix = []
    for scope in baseline:
        row = row_for_baseline(scope)
        description = row.get("description") or ""
        destroy = destructive_counterpart(ops, row.get("canonicalName") or scope, description)
        if scope in EXCLUDED_SCOPES:
            destroy = {"status": "excluded", "operation": None, "requiredScopes": [scope], "covered": "excluded by policy"}
        tool = None
        info = row.get("coverage") or {}
        if info.get("operationCount") and row.get("status") in {"current", "endpoint_only"} and scope not in EXCLUDED_SCOPES:
            tool = "domain read tool and hubspot_prepare_change"
        matrix.append(
            {
                "baselineScope": scope,
                "resource": description[:240],
                "supportedStatus": row.get("status"),
                "canonicalName": row.get("canonicalName"),
                "relatedDeleteOrArchive": destroy,
                "exactRequiredScopes": destroy.get("requiredScopes") or [],
                "alreadyCoveredOrNewlyNeeded": destroy.get("covered"),
                "mcpToolAvailability": tool or "no implemented tool",
                "exclusionOrPolicy": EXCLUDED_SCOPES.get(scope) or row.get("exclusionReason"),
                "documentationLink": row.get("sourceUrl") or SCOPES_URL,
                "verificationStatus": "documented_scope_not_live_tested",
            }
        )

    existing_originals = {row["originalName"] for row in scope_rows}
    for scope in baseline:
        if scope in existing_originals:
            continue
        extra = row_for_baseline(scope)
        scope_rows.append(
            {
                "originalName": extra["originalName"],
                "canonicalName": extra.get("canonicalName") or scope,
                "status": extra.get("status") or "unverified",
                "products": extra.get("products") or "",
                "description": extra.get("description") or "",
                "appAccess": "baseline audit row",
                "coverage": extra.get("coverage") or coverage(ops, scope),
                "companionScopes": extra.get("companionScopes") or "See the baseline matrix.",
                "sourceUrl": extra.get("sourceUrl") or SCOPES_URL,
                "docLinks": extra.get("docLinks") or [],
                "retrievedAt": RETRIEVED,
                "apiVersion": API_VERSION,
                "requested": False,
                "granted": "not_granted",
                "implementedTools": [],
                "tested": "not_runtime_tested",
                "exclusionReason": extra.get("exclusionReason"),
                "discrepancy": extra.get("discrepancy"),
            }
        )
        existing_originals.add(scope)
        by_name.setdefault(extra.get("canonicalName") or scope, scope_rows[-1])

    requested = []
    for row in scope_rows:
        scope = row["canonicalName"]
        if row["status"] not in {"current", "endpoint_only"}:
            continue
        if scope in EXCLUDED_SCOPES or scope in NO_API or scope in DEPRECATED or scope in BETA_CANDIDATES:
            continue
        if row.get("coverage", {}).get("operationCount", 0) < 1:
            continue
        if any(op["excluded"] and scope in [name for group in op["scopeGroups"] for name in group["scopes"]] and not any(not other["excluded"] and scope in [name for group in other["scopeGroups"] for name in group["scopes"]] for other in ops) for op in ops):
            continue
        requested.append(scope)
        row["requested"] = True
        tools = sorted({op["tool"] for op in ops if op["tool"] and any(scope in group["scopes"] for group in op["scopeGroups"])})
        row["implementedTools"] = tools

    def all_accounts(scope: str) -> bool:
        products = (by_name.get(scope) or {}).get("products") or ""
        return products.lower().startswith("available to all accounts")

    required = ["oauth"] if "oauth" in catalog_names or "oauth" in requested else []
    required.extend(sorted(scope for scope in requested if scope != "oauth" and all_accounts(scope)))
    optional = sorted(scope for scope in requested if scope not in required)
    omitted = []
    for scope, reason in sorted(EXCLUDED_SCOPES.items()):
        omitted.append({"scope": scope, "reason": reason})
    for scope in sorted(NO_API):
        omitted.append({"scope": scope, "reason": "Official scopes page: no corresponding API."})
    for scope in sorted(DEPRECATED):
        omitted.append({"scope": scope, "reason": "Official scopes page: deprecated. Not used for this new app."})
    for scope, reason in sorted(BETA_CANDIDATES.items()):
        omitted.append({"scope": scope, "reason": reason})
    for row in scope_rows:
        if row["status"] == "legacy":
            omitted.append({"scope": row["originalName"], "reason": "Legacy scope. Granular replacements are requested only when they have a verified operation."})
        elif row["status"] in {"current", "endpoint_only"} and not row["requested"] and row["canonicalName"] not in EXCLUDED_SCOPES:
            omitted.append({"scope": row["canonicalName"], "reason": "No implemented 2026-09 operation requires this scope, so it is not requested."})

    for op in ops:
        if op["implemented"] and op["tool"]:
            names = [name for group in op["scopeGroups"] for name in group["scopes"]]
            if any(name in EXCLUDED_SCOPES and set(names) <= set(EXCLUDED_SCOPES) for name in names):
                op["implemented"] = False
                op["tool"] = None

    tools = {}
    for op in ops:
        if not op["implemented"] or not op["tool"]:
            continue
        tools.setdefault(op["tool"], {"name": op["tool"], "operationCount": 0, "effects": set(), "domains": set()})
        tools[op["tool"]]["operationCount"] += 1
        tools[op["tool"]]["effects"].add(op["effect"])
        tools[op["tool"]]["domains"].add(op["domain"])
    inventory = []
    for tool in sorted(tools):
        if tool == "hubspot_prepare_change":
            continue
        item = tools[tool]
        inventory.append(
            {
                "name": item["name"],
                "operationCount": item["operationCount"],
                "effects": sorted(item["effects"]),
                "domains": sorted(item["domains"]),
                "dispatch": "operationId allowlist; path and method come from the operation register",
            }
        )
    inventory.extend(
        [
            {"name": "hubspot_list_operations", "operationCount": len([op for op in ops if op["implemented"]]), "effects": ["read"], "domains": ["registry"], "dispatch": "filters the operation register"},
            {"name": "hubspot_prepare_change", "operationCount": len([op for op in ops if op["implemented"] and op["effect"] == "mutate"]), "effects": ["mutate"], "domains": ["all implemented mutate operations"], "dispatch": "prepares an allowlisted mutation"},
            {"name": "hubspot_execute_change", "operationCount": len([op for op in ops if op["implemented"] and op["effect"] == "mutate"]), "effects": ["mutate"], "domains": ["all implemented mutate operations"], "dispatch": "executes a single-use server approval"},
            {"name": "hubspot_capabilities", "operationCount": 0, "effects": ["read"], "domains": ["registry"], "dispatch": "returns coverage counts and grant state"},
        ]
    )

    meta = {
        "retrievedAt": RETRIEVED,
        "apiVersion": API_VERSION,
        "versioningUrl": VERSIONING_URL,
        "scopesUrl": SCOPES_URL,
        "docsIndexUrl": DOCS_INDEX,
        "apiIndexUrl": INDEX_URL,
        "catalogCount": len(catalog),
        "pagesDiscovered": len(pages),
        "operationCount": len(ops),
        "implementedOperationCount": len([op for op in ops if op["implemented"]]),
        "excludedOperationCount": len([op for op in ops if op["excluded"]]),
        "scopeRegisterCount": len(scope_rows),
        "baselineCount": len(baseline),
        "baselineMatrixCount": len(matrix),
        "endpointOnlyScopes": sorted(row["canonicalName"] for row in scope_rows if row["status"] == "endpoint_only"),
        "scopeConflicts": conflicts,
        "pageFailures": page_failures,
        "accountLogin": "not_performed",
        "granted": "not_granted",
        "liveHubSpotCalls": "none",
        "completeness": "Catalog rows are the first-column scopes from the official scopes page HTML table on the retrieval date. Operations are 2026-09 API reference pages reached from the official docs index that publish a method, path, and Required Scopes block. 2027-03-beta specs were not implemented. A guessed absolute spec JSON URL returned 404 during planning; this register uses the rendered API reference pages instead. Account installer acceptance was not checked.",
    }

    def write(name: str, value: object) -> None:
        (REGISTERS / name).write_text(json.dumps(value, indent=2) + "\n")

    write("catalog-scopes.json", catalog)
    write("operations.json", ops)
    write("scope-register.json", scope_rows)
    write("baseline-matrix.json", matrix)
    write("scope-manifest.json", {"required": required, "optional": optional, "omitted": omitted, "retrievedAt": RETRIEVED, "apiVersion": API_VERSION})
    write("tool-inventory.json", inventory)
    write("discovery-meta.json", meta)
    proposal = ROOT / "proposed"
    proposal.mkdir(exist_ok=True)
    (proposal / "app-hsmeta.json").write_text(
        json.dumps(
            {
                "uid": "hubspot_api_mcp",
                "type": "app",
                "config": {
                    "name": "Apartment Life HubSpot API MCP",
                    "description": "Draft only. This file is not uploaded. A separate public app for the custom API-backed MCP. It is not the hosted connector app.",
                    "distribution": "private",
                    "auth": {
                        "type": "oauth",
                        "redirectUrls": ["http://127.0.0.1:8787/hubspot/oauth/callback"],
                        "requiredScopes": required,
                        "optionalScopes": optional,
                        "conditionallyRequiredScopes": [],
                    },
                },
            },
            indent=2,
        )
        + "\n"
    )
    print(json.dumps({k: meta[k] for k in ("catalogCount", "operationCount", "implementedOperationCount", "baselineCount", "pageFailures")}, indent=2))


if __name__ == "__main__":
    main()
