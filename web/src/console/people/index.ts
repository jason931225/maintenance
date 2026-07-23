import { PeopleWorkforceBody } from "./PeopleWorkforceBody";

/** Integration-owned shell/nav code mounts this descriptor without needing to
 * infer the route, privilege-sensitive body, or test contract from this module. */
export const PEOPLE_WORKFORCE_ROUTE = {
  screen: "people",
  pathname: "/console/people",
  authorization: {
    readFeature: "employee_directory_read",
    manageFeature: "employee_directory_manage",
  },
  Component: PeopleWorkforceBody,
} as const;

export { PeopleWorkforceBody };
