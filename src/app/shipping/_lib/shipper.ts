// Where every shipment ships FROM. Until streetLines is filled in,
// fedexConfigured() reports it missing and nothing calls FedEx.
// Not a secret -- it prints on every label.

export const SHIPPER = {
  company: "PharmaCenter",
  contactName: "Shipping",
  phone: "",
  streetLines: [] as string[],
  city: "Davie",
  stateProvince: "FL",
  postalCode: "",
  countryCode: "US",
};
