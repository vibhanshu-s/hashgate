import type { Metadata } from "next";
import { Console } from "./Console";

export const metadata: Metadata = { title: "Console — Hashgate" };

export default function Page() {
  return <Console />;
}
