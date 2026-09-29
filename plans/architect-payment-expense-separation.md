# Architecture Plan: Complete Separation of Payment and Expense Modules

## Objective
Completely decouple the Payment and Expense modules across both backend and frontend. Remove any shared type-switching endpoints (`/api/vouchers/daily`, `/api/vouchers/monthly`), shared modals, and toggle dropdowns. Ensure Payment handles ONLY student fee collections and Expense handles ONLY institutional expenses.

---

## 1. Backend API Separation
Replace the shared `/api/vouchers/daily` and `/api/vouchers/monthly` endpoints with dedicated, independent endpoints:

- **Payments**:
  - `GET /api/payments/daily?date=YYYY-MM-DD`: Queries ONLY `payments` table joined with `classes` and `students`.
  - `GET /api/payments/monthly?year=YYYY&month=M`: Queries ONLY `payments` table grouped by calendar days of the month.
- **Expenses**:
  - `GET /api/expenses/daily?date=YYYY-MM-DD`: Queries ONLY `expenses` table joined with `expense_categories`.
  - `GET /api/expenses/monthly?year=YYYY&month=M`: Queries ONLY `expenses` table grouped by calendar days of the month.

---

## 2. Frontend Modal & UI Separation
Remove `openDailyVoucherModal` and `openMonthlyVoucherModal` that used a `defaultType` switch. Implement four independent modal functions:

1. `openDailyPaymentVoucherModal()` -> Calls `/api/payments/daily`
2. `openMonthlyPaymentVoucherModal()` -> Calls `/api/payments/monthly`
3. `openDailyExpenseVoucherModal()` -> Calls `/api/expenses/daily`
4. `openMonthlyExpenseVoucherModal()` -> Calls `/api/expenses/monthly`

Update buttons in [`frontend/payments.html`](frontend/payments.html:1) and [`frontend/expenses.html`](frontend/expenses.html:1) to call their respective dedicated modal functions.

---

## 3. Mermaid Architecture Diagram

```mermaid
graph TD
    subgraph Payment Module
        PM[Payments Page] -->|GET /api/payments| PD[Payments Ledger]
        PM -->|GET /api/payments/daily| DPV[Daily Payment Voucher Modal]
        PM -->|GET /api/payments/monthly| MPV[Monthly Payment Voucher Modal]
    end

    subgraph Expense Module
        EM[Expenses Page] -->|GET /api/expenses| EL[Expenses Ledger]
        EM -->|GET /api/expenses/daily| DEV[Daily Expense Voucher Modal]
        EM -->|GET /api/expenses/monthly| MEV[Monthly Expense Voucher Modal]
    end

    subgraph Dashboard
        DB[Dashboard API] -->|Inflow| PD
        DB -->|Outflow| EL
    end
