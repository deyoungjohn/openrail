# @openrail/react

A React button that opens the hosted Openrail pay page in an accessible dialog. It is the React
counterpart of the script-tag widget (`packages/widget`) and speaks the same message protocol.
No keys are needed in the browser.

```tsx
import { OpenrailPayButton } from "@openrail/react";

<OpenrailPayButton
  payUrl="https://openrail.example"
  invoice="c-12"
  onPaid={() => router.refresh()}
>
  Pay invoice
</OpenrailPayButton>
```

Props:
- `payUrl` (required): the hosted pay origin (http or https only).
- `invoice`: a claim token id, which opens `<payUrl>/pay/<invoice>`. Or `path`: any absolute path on the pay origin. Give exactly one; a path that would leave the origin is refused.
- `children`: the button content (default "Pay invoice"). `className`, `style` and `disabled` are passed to the button.
- `onPaid(message)`: called once when the pay page posts `{type: "openrail:payment-complete"}` (or `"openrail:paid"`) from the pay origin. Messages from any other origin are ignored. The dialog then closes.
- `onClose()`: called whenever the dialog closes.

The dialog closes on Esc, on the close button and on a backdrop click, and focus returns to the
button. Styling uses the same `--openrail-*` custom properties as the widget.

Do X → see Y: `pnpm --filter @openrail/react test` → see the URL, origin-check and render tests pass.
