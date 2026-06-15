data "oci_objectstorage_namespace" "ns" {
  compartment_id = var.compartment_ocid
}

# DB PITR backups (CNPG Barman) + evidence object store (S3-compatible API).
resource "oci_objectstorage_bucket" "db_backups" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  name           = "mnt-db-backups"
  access_type    = "NoPublicAccess"
  versioning     = "Enabled" # extra protection for backup objects
  freeform_tags  = var.tags
}

resource "oci_objectstorage_bucket" "evidence" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  name           = "mnt-evidence"
  access_type    = "NoPublicAccess"
  freeform_tags  = var.tags
}
