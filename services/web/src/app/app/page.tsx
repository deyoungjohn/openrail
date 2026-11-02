import { copy } from "@/copy";

export default function Dashboard() {
  return (
    <>
      <h1 className="text-[32px] leading-10 font-bold">{copy.appHome.title}</h1>
      <p className="caption mt-1">{copy.appHome.body}</p>
    </>
  );
}
