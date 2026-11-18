import type { Metadata } from "next";
import { Activity } from "./Activity";

export const metadata: Metadata = { title: "Activity — Hashgate" };
export default function Page() {
  return <Activity />;
}
