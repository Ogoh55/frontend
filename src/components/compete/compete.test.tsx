import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CompetitionCard } from "./CompetitionCard";
import { CompetitionRules } from "./CompetitionRules";
import { CompetitionStatusBadge } from "./CompetitionStatusBadge";
import { LeaderboardTable } from "./LeaderboardTable";
import { MyRankCard } from "./MyRankCard";
import { PrizeTiers } from "./PrizeTiers";
import { RegistrationCard, type RegistrationCardProps } from "./RegistrationCard";
import { ResultsPanel } from "./ResultsPanel";
import { makeConfig, makeEntry, makeRank, makeResults, makeSummary } from "../../test/fixtures";

// `next/link` needs the App Router context; stub it so these stay unit tests.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

const ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV";

function renderCard(overrides: Partial<RegistrationCardProps> = {}) {
  const props: RegistrationCardProps = {
    phase: "upcoming",
    window: "open",
    address: ADDRESS,
    status: "not_registered",
    displayName: null,
    submitting: false,
    error: null,
    onRegister: vi.fn(),
    ...overrides,
  };
  return { ...render(<RegistrationCard {...props} />), props };
}

describe("CompetitionStatusBadge", () => {
  it("labels each phase", () => {
    const { rerender } = render(<CompetitionStatusBadge phase="upcoming" />);
    expect(screen.getByTestId("competition-status")).toHaveTextContent("Upcoming");

    rerender(<CompetitionStatusBadge phase="active" />);
    expect(screen.getByTestId("competition-status")).toHaveTextContent("Live");

    rerender(<CompetitionStatusBadge phase="ended" />);
    expect(screen.getByTestId("competition-status")).toHaveTextContent("Ended");
  });
});

describe("RegistrationCard — before the competition", () => {
  it("prompts to connect instead of showing a dead button", () => {
    renderCard({ address: null });
    expect(screen.getByTestId("participation-status")).toHaveTextContent("Not entered");
    expect(screen.getByText(/connect your wallet to enter/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enter competition/i })).not.toBeInTheDocument();
  });

  it("registers with an optional display name", () => {
    const { props } = renderCard();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "nova" } });
    fireEvent.click(screen.getByRole("button", { name: /enter competition/i }));
    expect(props.onRegister).toHaveBeenCalledWith("nova");
  });

  it("registers without a display name when the field is left blank", () => {
    const { props } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: /enter competition/i }));
    expect(props.onRegister).toHaveBeenCalledWith("");
  });

  it("shows a signing state and surfaces an error", () => {
    renderCard({ submitting: true, error: "Signature rejected" });
    expect(screen.getByRole("button", { name: /enter competition/i })).toHaveTextContent("Signing…");
    expect(screen.getByTestId("registration-error")).toHaveTextContent("Signature rejected");
  });
});

describe("RegistrationCard — registered", () => {
  it("shows participation status and allows changing the display name", () => {
    const onUpdateDisplayName = vi.fn();
    renderCard({ status: "registered", displayName: "aurora", onUpdateDisplayName });

    expect(screen.getByTestId("participation-status")).toHaveTextContent("Registered");
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "quietwave" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onUpdateDisplayName).toHaveBeenCalledWith("quietwave");
  });

  it("marks a disqualified entry and explains why it cannot win", () => {
    renderCard({ status: "disqualified" });
    expect(screen.getByTestId("participation-status")).toHaveTextContent("Disqualified");
    expect(screen.getByText(/not eligible for prizes/i)).toBeInTheDocument();
  });
});

describe("RegistrationCard — after the window closes", () => {
  it("explains that registration closed at the start while the event is live", () => {
    renderCard({ phase: "active", window: "closed" });
    expect(screen.getByText(/registration closed when the competition started/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enter competition/i })).not.toBeInTheDocument();
  });

  it("explains that the competition has ended", () => {
    renderCard({ phase: "ended", window: "ended" });
    expect(screen.getByText(/has ended, so entry is closed/i)).toBeInTheDocument();
  });
});

describe("LeaderboardTable", () => {
  const base = {
    scoringMethod: "percent_return" as const,
    total: 2,
    page: 1,
    pageSize: 25,
    search: "",
    onSearchChange: vi.fn(),
    onPageChange: vi.fn(),
  };

  it("shows pseudonyms, truncated addresses, and ties", () => {
    const entries = [
      makeEntry({ rank: 1, display_name: "aurora", score: 10, wallet_address: "GAAAA" }),
      makeEntry({ rank: 2, display_name: null, score: 10, wallet_address: ADDRESS }),
    ];
    render(<LeaderboardTable {...base} entries={entries} />);

    expect(screen.getByText("aurora")).toBeInTheDocument();
    expect(screen.getByText("GABC…STUV")).toBeInTheDocument();

    const rows = screen.getAllByTestId("leaderboard-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-tied", "true");
    expect(within(rows[0]!).getByText("=1")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("=2")).toBeInTheDocument();
  });

  it("keeps disqualified entries visible with their status", () => {
    render(<LeaderboardTable {...base} total={1} entries={[makeEntry({ status: "disqualified" })]} />);
    const row = screen.getByTestId("leaderboard-row");
    expect(row).toHaveAttribute("data-status", "disqualified");
    expect(within(row).getByText("Disqualified")).toBeInTheDocument();
  });

  it("reports search changes upward instead of filtering the current page", () => {
    const onSearchChange = vi.fn();
    render(<LeaderboardTable {...base} entries={[makeEntry()]} onSearchChange={onSearchChange} />);
    fireEvent.change(screen.getByLabelText(/search by address/i), { target: { value: "GABC" } });
    expect(onSearchChange).toHaveBeenCalledWith("GABC");
  });

  it("paginates with a disabled Prev on the first page", () => {
    const onPageChange = vi.fn();
    render(
      <LeaderboardTable {...base} entries={[makeEntry()]} total={60} page={1} onPageChange={onPageChange} />
    );
    expect(screen.getByText("Page 1 / 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous page/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("shows the phase-appropriate empty copy", () => {
    render(<LeaderboardTable {...base} total={0} entries={[]} emptyLabel="No entries yet — be the first to opt in." />);
    expect(screen.getByTestId("leaderboard-empty")).toHaveTextContent("No entries yet");
  });
});

describe("MyRankCard", () => {
  it("distinguishes no session from not entered", () => {
    const { rerender } = render(<MyRankCard rank={null} scoringMethod="percent_return" connected={false} />);
    expect(screen.getByTestId("my-rank")).toHaveAttribute("data-state", "disconnected");

    rerender(<MyRankCard rank={null} scoringMethod="percent_return" connected />);
    expect(screen.getByTestId("my-rank")).toHaveAttribute("data-state", "not-entered");
  });

  it("shows a rank and score when ranked", () => {
    render(<MyRankCard rank={makeRank()} scoringMethod="percent_return" prizeTiers={makeConfig().prize_tiers} connected />);
    const card = screen.getByTestId("my-rank");
    expect(card).toHaveAttribute("data-state", "ranked");
    expect(card).toHaveTextContent("#3");
    expect(card).toHaveTextContent("+12.50%");
    expect(card).toHaveTextContent(/prize position/i);
  });

  it("explains which threshold an unranked entry is missing", () => {
    render(
      <MyRankCard
        rank={makeRank({ rank: null, min_trades_met: false, min_volume_met: false })}
        scoringMethod="percent_return"
        connected
      />
    );
    const card = screen.getByTestId("my-rank");
    expect(card).toHaveAttribute("data-state", "unranked");
    expect(card).toHaveTextContent(/minimum trades/);
    expect(card).toHaveTextContent(/minimum volume/);
  });

  it("marks a disqualified entry", () => {
    render(<MyRankCard rank={makeRank({ status: "disqualified", rank: null })} scoringMethod="percent_return" connected />);
    expect(screen.getByTestId("my-rank")).toHaveAttribute("data-state", "disqualified");
  });
});

describe("CompetitionRules", () => {
  it("renders every configured rule from the config", () => {
    render(<CompetitionRules competition={makeConfig()} phase="active" />);

    const rules = screen.getByTestId("competition-rules");
    expect(rules).toHaveTextContent("Autumn XLM Sprint");
    expect(rules).toHaveTextContent("XLM, BTC");
    expect(rules).toHaveTextContent("% Return");
    expect(rules).toHaveTextContent("Champion");
    expect(rules).toHaveTextContent("$500.00");
    expect(rules).toHaveTextContent("No wash trades.");
    // Anti-gaming thresholds are surfaced before anyone trades.
    expect(rules).toHaveTextContent(/minimum 3 trades/i);
  });
});

describe("PrizeTiers", () => {
  it("highlights the band the viewer is in", () => {
    render(<PrizeTiers tiers={makeConfig().prize_tiers} highlightRank={2} />);
    const tiers = screen.getAllByTestId("prize-tier");
    expect(tiers[0]).not.toHaveAttribute("data-highlighted");
    expect(tiers[1]).toHaveAttribute("data-highlighted", "true");
  });
});

describe("ResultsPanel", () => {
  it("lists final standings with rewards and flags the viewer's row", () => {
    render(<ResultsPanel results={makeResults()} highlightAddress={ADDRESS} />);
    const rows = screen.getAllByTestId("results-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("$500.00")).toBeInTheDocument();
    expect(screen.getByText("$200.00")).toBeInTheDocument();
    expect(rows[0]).toHaveAttribute("data-mine", "true");
  });
});

describe("CompetitionCard", () => {
  it("links to the detail page and summarises the config", () => {
    render(<CompetitionCard competition={makeSummary()} phase="active" />);
    const card = screen.getByTestId("competition-card");
    expect(card).toHaveAttribute("href", "/compete/comp-1");
    expect(card).toHaveTextContent("Autumn XLM Sprint");
    expect(card).toHaveTextContent("$700.00");
    expect(card).toHaveTextContent("42");
  });
});
