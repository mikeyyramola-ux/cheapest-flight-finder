import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { DESTINATIONS, destinationPath } from "@shared/destinations";

/** App-level event: any control can open the nav search (the topbar button dispatches it). */
const OPEN_EVENT = "fareloop:open-search";

const PAGES: { value: string; label: string; path: string }[] = [
  { value: "find flights", label: "Find flights", path: "/" },
  { value: "deal tracker", label: "Deal tracker", path: "/tracker" },
  { value: "upgrade premium", label: "Upgrade - premium", path: "/paywall" },
  { value: "faq help", label: "FAQ", path: "/faq" },
  { value: "flights to hub", label: "Flights to destinations", path: "/flights-to" },
  { value: "grievance redressal", label: "Grievance redressal", path: "/grievance" },
  { value: "refund policy", label: "Refund policy", path: "/refund-policy" },
  { value: "ops console", label: "Ops console", path: "/ops" },
];

export default function NavSearchDialog() {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(previous => !previous);
      }
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const goTo = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search Fareloop"
      description="Jump to a page or destination"
    >
      <CommandInput placeholder="Search pages and destinations..." />
      <CommandList>
        <CommandEmpty>No page or destination found.</CommandEmpty>
        <CommandGroup heading="Pages">
          {PAGES.map(page => (
            <CommandItem key={page.path} value={page.value} onSelect={() => goTo(page.path)}>
              {page.label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Destinations">
          {DESTINATIONS.map(destination => (
            <CommandItem
              key={destination.code}
              value={`flights to ${destination.city} ${destination.code}`}
              onSelect={() => goTo(destinationPath(destination.slug))}
            >
              Flights to {destination.city} ({destination.code})
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
