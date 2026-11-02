---
name: design-studio-pack
description: General design briefs, visual review and concept directions plus a space-planning and interior-design workflow skill for project briefs, measured or scanned drawing intake, layout review, interior visualization direction, FF&E and finish schedules, site surveys, IFC model audits, and read-only Revit evidence gathering. Use for residential, workplace, retail, restaurant, hospitality, renovation, fit-out, and existing-building interior projects. The interior-specific workflow does not cover branding, graphic identity, UI design, facade or massing concepts, structural calculations, permitting design, or unreviewed construction-document claims.
---

# Design Studio Pack

Use this workflow to turn client requirements and project evidence into reviewable interior-design decisions. Keep facts, reported information, assumptions, and recommendations separate.

## General design compatibility

The original `design_brief_builder`, `design_review_checklist`, and `visual_direction_board` tools remain available for creative briefs, UI/brand review, and concept prompts. They return analysis and plans; they do not generate image files or modify external systems. Choose these only for an explicitly requested general design task.

## Interior workflow

1. Define scope with `interior_project_brief`. Confirm project type, users, spaces, budget, fixed conditions, exclusions, and required professional coordination.
2. Register source quality with `drawing_ingest_qa`. Do not infer scale from a scan without at least one independently verified dimension.
3. Review zoning, adjacency, circulation, furniture use zones, accessibility, structure, fire, and MEP constraints with `space_planning_checklist`.
4. For IFC evidence, call `ifc_space_audit_plan` before using `mcp_ifc-readonly_*` tools. Cite model revision, element ids, and exact query results.
5. For a live Revit model, call `revit_readonly_review_plan` before using `mcp_revit-readonly_*` tools. Keep the query bounded to the active view, selected elements, or an explicit category/level/phase scope.
6. Normalize schedule rows with `ffe_schedule_normalize`; preserve source rows and never guess units, dimensions, quantities, prices, or lead times.
7. Record site evidence with `site_survey_report`. Keep direct observations separate from client- or consultant-reported information.
8. Use `interior_visual_direction` only after layout and fixed conditions are approved. Preserve openings, structure, levels, ceiling heights, services, circulation, and furniture scale.

## Optional managed connectors

- Use `mcp_paddleocr-local_pp_structurev3` for complex local scans, drawing layouts, and tables. Treat OCR as review evidence, not verified geometry.
- Use only the allowlisted `mcp_ifc-readonly_*` inspection, validation, clash, plot, and render tools. IFC create, save, edit, shape, and quantify operations are prohibited.
- Use only read-only `mcp_revit-readonly_*` queries. Arbitrary Revit code, baked tools, model writes, transactions, saves, sync, and publishing are prohibited.
- Keep connector file inputs inside the Lumi project data root. Managed connectors do not accept network URLs.

## Delivery rules

- Never present a concept drawing, OCR result, IFC query, rendered image, or local handoff file as a reviewed construction document.
- Report missing measurements, inaccessible conditions, model ambiguity, coordination gaps, and required consultant checks explicitly.
- Escalate structural, fire, MEP, hazardous-material, accessibility-code, and permitting decisions to qualified professionals.
- The interior workflow excludes brand identity, logos, campaign assets, UI, product-interface design, facade design, massing, and full architectural authoring. General creative tools do not certify construction or permitting work.
