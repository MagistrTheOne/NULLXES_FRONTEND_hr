import { JoinResolver } from "../../_components/join-resolver";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CandidateJoinPage({
  params
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <JoinResolver role="candidate" token={token} />;
}
