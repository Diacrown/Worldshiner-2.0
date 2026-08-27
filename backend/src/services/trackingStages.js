// Maps the 35 internal branch statuses (seed.js BRANCH_STATUSES) onto a
// small set of customer-facing stages for the public tracking page — a
// client should never see raw internal vocabulary like "Mod CAD Recd." or
// "With Polisher". `on_hold` and `not_proceeding` are deliberately excluded
// (mapped to null): they're side-states shown as a banner, not a point on
// the linear progress track, since a job can go on hold from any stage.
export const STAGE_ORDER = [
  { key: 'order_received', label: 'Order Received', description: "We've received your order and are finalizing the details." },
  { key: 'design', label: 'Design & CAD', description: 'Your piece is being designed and the CAD/render is being prepared and approved.' },
  { key: 'production', label: 'In Production', description: 'Your piece is being cast, set, and finished by hand.' },
  { key: 'quality_check', label: 'Quality Check', description: 'Your piece is going through final quality inspection.' },
  { key: 'shipping', label: 'Shipping', description: 'Your piece is packed and on its way.' },
  { key: 'completed', label: 'Delivered', description: 'Your order is complete.' },
];

export const STAGE_LABELS = Object.fromEntries(STAGE_ORDER.map((s) => [s.key, s.label]));

export const STAGE_FOR_STATUS = {
  quoting: 'order_received',
  additional_info_needed: 'order_received',
  quote_received: 'order_received',
  quote_given: 'order_received',
  additional_quote_given: 'order_received',
  quote_approved: 'order_received',

  new_cad_requested: 'design',
  making_cad: 'design',
  cad_received: 'design',
  cad_provided: 'design',
  request_modification: 'design',
  modifying_cad: 'design',
  mod_cad_received: 'design',
  cad_approved: 'design',
  request_render: 'design',
  render_in_progress: 'design',
  render_received: 'design',
  render_submitted: 'design',
  confirm_order: 'design',

  production_started: 'production',
  request_wax: 'production',
  wax_in_production: 'production',
  wax_deliver: 'production',
  local_production: 'production',
  in_setting: 'production',
  with_setter: 'production',
  with_polisher: 'production',

  in_repair: 'quality_check',
  job_delayed: 'quality_check',

  ready_to_ship: 'shipping',
  in_transit: 'shipping',
  shipped_india: 'shipping',

  job_completed: 'completed',

  on_hold: null,
  not_proceeding: null,
};
