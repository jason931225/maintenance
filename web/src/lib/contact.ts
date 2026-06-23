/**
 * Single source of truth for KNL's public-facing contact phone numbers.
 *
 * The storefront repeats these in several places (nav, contact bands, the
 * contact page cards, the intake fallback). Display strings use the dashed
 * format (010-style readability); `tel:` links use the bare digit form so the
 * dialer parses them. Reference these constants instead of re-typing the
 * literals so a number change is a one-line edit.
 */

/** Business / sales / rental inquiries. */
export const SALES_PHONE_DISPLAY = "070-4443-0319";
export const SALES_PHONE_HREF = "tel:07044430319";

/** Repair / breakdown / emergency inquiries. */
export const REPAIR_PHONE_DISPLAY = "070-4443-0320";
export const REPAIR_PHONE_HREF = "tel:07044430320";
