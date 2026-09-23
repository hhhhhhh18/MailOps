import { redirect } from "next/navigation";

/** The dashboard is the product's home. */
export default function RootPage() {
  redirect("/dashboard");
}
